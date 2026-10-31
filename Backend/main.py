
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import formataddr
import hashlib
import hmac
import logging
import os
from pathlib import Path
import re
import secrets
import sqlite3
import smtplib
import ssl
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Literal


app = FastAPI(title="MediSync AI API")
logger = logging.getLogger(__name__)


def load_backend_environment():
    env_file = Path(__file__).resolve().parent / ".env"
    if not env_file.exists():
        return

    for line in env_file.read_text(encoding="utf-8").splitlines():
        stripped_line = line.strip()
        if not stripped_line or stripped_line.startswith("#") or "=" not in stripped_line:
            continue
        key, value = stripped_line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("\"'")
        if key and key not in os.environ:
            os.environ[key] = value


load_backend_environment()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5500",
        "http://localhost:5500",
        "http://127.0.0.1:5501",
        "http://localhost:5501",
        "http://127.0.0.1:5502",
        "http://localhost:5502",
    ],
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

@app.middleware("http")
async def disable_patient_data_caching(request: Request, call_next):
    response = await call_next(request)
    if (
        request.url.path.startswith("/auth/")
        or request.url.path.startswith("/visits")
        or request.url.path.startswith("/patients/")
        or request.url.path.startswith("/demo/")
    ):
        response.headers["Cache-Control"] = "no-store"
    return response


# Store the database inside the backend folder.
DB_PATH = Path(__file__).resolve().parent / "medisync.db"
FRONTEND_DIR = Path(__file__).resolve().parent.parent
SIGNUP_CODE_DURATION = timedelta(minutes=10)
SIGNUP_CODE_RESEND_DELAY = timedelta(seconds=60)
SIGNUP_CODE_MAX_ATTEMPTS = 5
SIGNUP_CODE_HASH_ITERATIONS = 200_000


@contextmanager
def get_connection():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


# Create the table automatically when the backend starts.
def initialize_database():
    with get_connection() as connection:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS visits (
                id TEXT PRIMARY KEY,
                patient_id TEXT NOT NULL,
                name TEXT NOT NULL,
                visit_date TEXT NOT NULL,
                visit_type TEXT NOT NULL,
                age INTEGER,
                gender TEXT NOT NULL DEFAULT '',
                health_issue TEXT NOT NULL DEFAULT '',
                prescribed_medication TEXT NOT NULL DEFAULT '',
                tests_and_investigations TEXT NOT NULL DEFAULT '',
                suggested_health_report_tests TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL,
                plan TEXT NOT NULL DEFAULT '',
                report_image TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                doctor_id TEXT
            )
        """)

        columns = connection.execute("PRAGMA table_info(visits)").fetchall()
        column_names = {row[1] for row in columns}
        if "report_image" not in column_names:
            connection.execute(
                "ALTER TABLE visits ADD COLUMN report_image TEXT NOT NULL DEFAULT ''"
            )
        if "doctor_id" not in column_names:
            connection.execute("ALTER TABLE visits ADD COLUMN doctor_id TEXT")
        if "age" not in column_names:
            connection.execute("ALTER TABLE visits ADD COLUMN age INTEGER")
        if "gender" not in column_names:
            connection.execute(
                "ALTER TABLE visits ADD COLUMN gender TEXT NOT NULL DEFAULT ''"
            )
        if "health_issue" not in column_names:
            connection.execute(
                "ALTER TABLE visits ADD COLUMN health_issue TEXT NOT NULL DEFAULT ''"
            )
        if "prescribed_medication" not in column_names:
            connection.execute(
                "ALTER TABLE visits ADD COLUMN prescribed_medication TEXT NOT NULL DEFAULT ''"
            )
        if "tests_and_investigations" not in column_names:
            connection.execute(
                "ALTER TABLE visits ADD COLUMN tests_and_investigations TEXT NOT NULL DEFAULT ''"
            )
        if "suggested_health_report_tests" not in column_names:
            connection.execute(
                "ALTER TABLE visits ADD COLUMN suggested_health_report_tests TEXT NOT NULL DEFAULT ''"
            )

        connection.execute("""
            CREATE TABLE IF NOT EXISTS doctors (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                password_salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        connection.execute("""
            CREATE TABLE IF NOT EXISTS auth_sessions (
                token_hash TEXT PRIMARY KEY,
                doctor_id TEXT NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
                expires_at TEXT NOT NULL
            )
        """)
        connection.execute("""
            CREATE TABLE IF NOT EXISTS signup_verifications (
                email TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                code_salt TEXT NOT NULL,
                code_hash TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                requested_at TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0
            )
        """)
        connection.execute("""
            CREATE TABLE IF NOT EXISTS patient_registry (
                owner_id TEXT NOT NULL,
                normalized_patient_id TEXT NOT NULL,
                patient_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (owner_id, normalized_patient_id)
            )
        """)
        connection.execute("""
            INSERT OR IGNORE INTO patient_registry
                (owner_id, normalized_patient_id, patient_id, created_at)
            SELECT
                COALESCE(doctor_id, '__demo__'),
                lower(trim(patient_id)),
                patient_id,
                MIN(created_at)
            FROM visits
            WHERE trim(patient_id) <> ''
            GROUP BY COALESCE(doctor_id, '__demo__'), lower(trim(patient_id))
        """)
        connection.execute(
            "CREATE INDEX IF NOT EXISTS visits_doctor_created ON visits(doctor_id, created_at)"
        )


initialize_database()

SESSION_COOKIE = "medisync_session"
SESSION_DURATION = timedelta(days=30)


class VisitRecord(BaseModel):
    id: str
    name: str
    patientId: str = ""
    date: str
    visitType: Literal[
        "General Consultation",
        "Follow-up",
        "Routine Check-up",
        "Other",
        "General consultation",
        "Routine checkup"
    ]
    age: int | None = None
    gender: str = ""
    healthIssue: str = ""
    prescribedMedication: str = ""
    testsAndInvestigations: str = ""
    suggestedHealthReportTests: str = ""
    isNewPatient: bool = False
    notes: str
    plan: str = ""
    reportImage: str = ""
    createdAt: str


def normalized_patient_id(patient_id: str) -> str:
    return patient_id.strip().lower()


def patient_registry_owner(doctor_id: str | None) -> str:
    return doctor_id or "__demo__"


def patient_id_exists(connection: sqlite3.Connection, owner_id: str, patient_id: str) -> bool:
    return connection.execute(
        """
        SELECT 1
        FROM patient_registry
        WHERE owner_id = ? AND normalized_patient_id = ?
        """,
        (owner_id, normalized_patient_id(patient_id)),
    ).fetchone() is not None


def reserve_new_patient_id(
    connection: sqlite3.Connection,
    visit: VisitRecord,
    owner_id: str | None,
) -> None:
    patient_id = visit.patientId.strip()
    if not patient_id:
        raise HTTPException(status_code=400, detail="A Patient ID is required for a new patient.")

    registry_owner = patient_registry_owner(owner_id)
    normalized_id = normalized_patient_id(patient_id)
    cursor = connection.execute(
        """
        INSERT OR IGNORE INTO patient_registry
            (owner_id, normalized_patient_id, patient_id, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (registry_owner, normalized_id, patient_id, visit.createdAt),
    )
    if cursor.rowcount == 0:
        existing_visit = connection.execute(
            """
            SELECT 1
            FROM visits
            WHERE id = ? AND COALESCE(doctor_id, '__demo__') = ?
              AND lower(trim(patient_id)) = ?
            """,
            (visit.id, registry_owner, normalized_id),
        ).fetchone()
        if existing_visit is None:
            raise HTTPException(
                status_code=409,
                detail=f"Patient ID {patient_id} already exists. Use Existing Patient to record another visit.",
            )
        return

class DoctorCredentials(BaseModel):
    email: str
    password: str


class DoctorSignup(DoctorCredentials):
    name: str


class SignupVerification(BaseModel):
    email: str
    code: str


def doctor_response(doctor: sqlite3.Row) -> dict:
    return {
        "id": doctor["id"],
        "name": doctor["name"],
        "email": doctor["email"],
    }


def ensure_request_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if not origin:
        return

    parsed_origin = urlsplit(origin)
    if parsed_origin.netloc == request.headers.get("host"):
        return
    if parsed_origin.scheme == "http" and parsed_origin.hostname in {"localhost", "127.0.0.1"}:
        return
    raise HTTPException(status_code=403, detail="Request origin is not allowed.")


def create_session(doctor_id: str, request: Request, response: Response) -> None:
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + SESSION_DURATION
    with get_connection() as connection:
        connection.execute(
            "DELETE FROM auth_sessions WHERE expires_at <= ?",
            (datetime.now(timezone.utc).isoformat(),),
        )
        connection.execute(
            "INSERT INTO auth_sessions (token_hash, doctor_id, expires_at) VALUES (?, ?, ?)",
            (
                hashlib.sha256(token.encode("utf-8")).hexdigest(),
                doctor_id,
                expires_at.isoformat(),
            ),
        )

    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        max_age=int(SESSION_DURATION.total_seconds()),
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="lax",
        path="/",
    )


def normalize_gmail_address(value: str) -> str:
    email = value.strip().lower()
    local_part, separator, domain = email.partition("@")
    valid_local_part = (
        bool(local_part)
        and len(local_part) <= 64
        and re.fullmatch(r"[a-z0-9.+]+", local_part) is not None
        and not local_part.startswith(".")
        and not local_part.endswith(".")
        and ".." not in local_part
    )
    if (
        not separator
        or domain != "gmail.com"
        or not valid_local_part
        or len(email) > 254
    ):
        raise HTTPException(
            status_code=400,
            detail="Enter a valid Gmail address ending in @gmail.com.",
        )
    return email


def canonical_gmail_address(email: str) -> str:
    local_part = email.partition("@")[0].split("+", 1)[0]
    return local_part.replace(".", "")


def hash_signup_code(code: str, salt_hex: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256",
        code.encode("ascii"),
        bytes.fromhex(salt_hex),
        SIGNUP_CODE_HASH_ITERATIONS,
    ).hex()


def send_signup_verification_email(email: str, name: str, code: str) -> None:
    username = os.environ.get("SMTP_USERNAME", "").strip()
    password = os.environ.get("SMTP_PASSWORD", "").strip()
    sender = os.environ.get("SMTP_FROM_EMAIL", username).strip()
    if not username or not password or not sender:
        raise HTTPException(
            status_code=503,
            detail="Email verification is not configured. Set SMTP_USERNAME, SMTP_PASSWORD, and SMTP_FROM_EMAIL in Backend/.env.",
        )

    try:
        port = int(os.environ.get("SMTP_PORT", "587"))
        message = EmailMessage()
        message["Subject"] = "Verify your Gmail address for MediSync"
        message["From"] = formataddr(
            (os.environ.get("SMTP_FROM_NAME", "MediSync"), sender)
        )
        message["To"] = email
        message.set_content(
            f"Hello {name},\n\n"
            "EMAIL ADDRESS VERIFICATION\n"
            "Use the code below to confirm that you can access this Gmail inbox "
            "and finish creating your MediSync doctor account.\n\n"
            f"Gmail address: {email}\n"
            f"Verification code: {code}\n\n"
            "Enter this 8-digit code on the MediSync signup screen. "
            "The code expires in 10 minutes. Your account will not be created "
            "until you enter the correct code.\n\n"
            "If you do not receive the email in your inbox, check your Spam "
            "or Promotions folder. Never share this code with anyone.\n\n"
            "If you did not request this verification, you can ignore this email."
        )

        with smtplib.SMTP(
            os.environ.get("SMTP_HOST", "smtp.gmail.com"),
            port,
            timeout=15,
        ) as server:
            server.starttls(context=ssl.create_default_context())
            server.login(username, password)
            server.send_message(message)
    except (OSError, ValueError, smtplib.SMTPException) as error:
        logger.exception("Could not send signup verification email.")
        raise HTTPException(
            status_code=503,
            detail="Could not send the verification email. Check the SMTP settings and try again.",
        ) from error


def current_doctor(request: Request) -> sqlite3.Row | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None

    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc).isoformat()
    with get_connection() as connection:
        return connection.execute(
            """
            SELECT doctors.id, doctors.name, doctors.email
            FROM auth_sessions
            JOIN doctors ON doctors.id = auth_sessions.doctor_id
            WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?
            """,
            (token_hash, now),
        ).fetchone()


def require_doctor(request: Request) -> sqlite3.Row:
    doctor = current_doctor(request)
    if doctor is None:
        raise HTTPException(status_code=401, detail="Please sign in to access doctor records.")
    return doctor


def serialize_visit(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "patientId": row["patient_id"],
        "name": row["name"],
        "date": row["visit_date"],
        "visitType": row["visit_type"],
        "age": row["age"],
        "gender": row["gender"],
        "healthIssue": row["health_issue"],
        "prescribedMedication": row["prescribed_medication"],
        "testsAndInvestigations": row["tests_and_investigations"],
        "suggestedHealthReportTests": row["suggested_health_report_tests"],
        "notes": row["notes"],
        "plan": row["plan"],
        "reportImage": row["report_image"],
        "createdAt": row["created_at"],
    }


@app.get("/")
def home():
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/style.css")
def frontend_styles():
    return FileResponse(FRONTEND_DIR / "style.css", media_type="text/css")


@app.get("/script.js")
def frontend_script():
    return FileResponse(
        FRONTEND_DIR / "script.js",
        media_type="text/javascript",
    )


@app.get("/service-worker.js")
def frontend_service_worker():
    return FileResponse(
        FRONTEND_DIR / "service-worker.js",
        media_type="text/javascript",
        headers={"Service-Worker-Allowed": "/"},
    )


@app.get("/health")
def health():
    return {"status": "healthy"}


@app.get("/auth/me")
def auth_me(request: Request):
    doctor = current_doctor(request)
    return {"doctor": doctor_response(doctor) if doctor else None}


@app.post("/auth/signup")
def auth_signup(account: DoctorSignup, request: Request):
    ensure_request_origin(request)
    name = account.name.strip()
    email = normalize_gmail_address(account.email)
    if not name or len(name) > 100:
        raise HTTPException(status_code=400, detail="Enter a name up to 100 characters.")
    if len(account.password) < 10 or len(account.password) > 256:
        raise HTTPException(status_code=400, detail="Password must be 10 to 256 characters.")

    with get_connection() as connection:
        existing_emails = connection.execute(
            "SELECT email FROM doctors WHERE lower(email) LIKE '%@gmail.com'"
        ).fetchall()
        if any(
            canonical_gmail_address(row["email"]) == canonical_gmail_address(email)
            for row in existing_emails
        ):
            raise HTTPException(
                status_code=409,
                detail="An account already exists for this Gmail address.",
            )

        now = datetime.now(timezone.utc)
        existing_challenge = connection.execute(
            "SELECT requested_at FROM signup_verifications WHERE email = ?",
            (email,),
        ).fetchone()
        if existing_challenge:
            requested_at = datetime.fromisoformat(existing_challenge["requested_at"])
            if now - requested_at < SIGNUP_CODE_RESEND_DELAY:
                raise HTTPException(
                    status_code=429,
                    detail="A verification code was just sent. Wait one minute before requesting another.",
                )

    password_salt = secrets.token_bytes(16)
    password_hash = hashlib.scrypt(
        account.password.encode("utf-8"),
        salt=password_salt,
        n=2**14,
        r=8,
        p=1,
        dklen=64,
    )
    code = f"{secrets.randbelow(100_000_000):08d}"
    code_salt = secrets.token_bytes(16).hex()
    now = datetime.now(timezone.utc)
    with get_connection() as connection:
        connection.execute(
            """
            INSERT INTO signup_verifications
                (email, name, password_salt, password_hash, code_salt,
                 code_hash, expires_at, requested_at, attempts)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(email) DO UPDATE SET
                name = excluded.name,
                password_salt = excluded.password_salt,
                password_hash = excluded.password_hash,
                code_salt = excluded.code_salt,
                code_hash = excluded.code_hash,
                expires_at = excluded.expires_at,
                requested_at = excluded.requested_at,
                attempts = 0
            """,
            (
                email,
                name,
                password_salt.hex(),
                password_hash.hex(),
                code_salt,
                hash_signup_code(code, code_salt),
                (now + SIGNUP_CODE_DURATION).isoformat(),
                now.isoformat(),
            ),
        )

    try:
        send_signup_verification_email(email, name, code)
    except HTTPException:
        with get_connection() as connection:
            connection.execute(
                "DELETE FROM signup_verifications WHERE email = ? AND code_hash = ?",
                (email, hash_signup_code(code, code_salt)),
            )
        raise

    return {
        "message": (
            f"Verification email sent to {email}. Enter the 8-digit code to "
            "confirm you own this inbox and create your account. Check Spam or "
            "Promotions if it is not in your inbox."
        )
    }


@app.post("/auth/signup/verify")
def auth_signup_verify(
    verification: SignupVerification,
    request: Request,
    response: Response,
):
    ensure_request_origin(request)
    email = normalize_gmail_address(verification.email)
    if not re.fullmatch(r"\d{8}", verification.code):
        raise HTTPException(status_code=400, detail="Enter the 8-digit verification code.")

    now = datetime.now(timezone.utc)
    failure_status = None
    failure_message = None
    doctor = None
    with get_connection() as connection:
        challenge = connection.execute(
            "SELECT * FROM signup_verifications WHERE email = ?",
            (email,),
        ).fetchone()
        if challenge is None:
            raise HTTPException(
                status_code=400,
                detail="No active verification request was found. Request a new code.",
            )

        if datetime.fromisoformat(challenge["expires_at"]) <= now:
            connection.execute(
                "DELETE FROM signup_verifications WHERE email = ?",
                (email,),
            )
            failure_status = 400
            failure_message = "The verification code expired. Request a new code."
        elif challenge["attempts"] >= SIGNUP_CODE_MAX_ATTEMPTS:
            connection.execute(
                "DELETE FROM signup_verifications WHERE email = ?",
                (email,),
            )
            failure_status = 429
            failure_message = "Too many incorrect codes. Request a new verification code."
        elif not hmac.compare_digest(
            hash_signup_code(verification.code, challenge["code_salt"]),
            challenge["code_hash"],
        ):
            attempts = challenge["attempts"] + 1
            if attempts >= SIGNUP_CODE_MAX_ATTEMPTS:
                connection.execute(
                    "DELETE FROM signup_verifications WHERE email = ?",
                    (email,),
                )
                failure_status = 429
                failure_message = "Too many incorrect codes. Request a new verification code."
            else:
                connection.execute(
                    "UPDATE signup_verifications SET attempts = ? WHERE email = ?",
                    (attempts, email),
                )
                failure_status = 400
                failure_message = (
                    f"That code is incorrect. "
                    f"{SIGNUP_CODE_MAX_ATTEMPTS - attempts} attempt(s) remain."
                )
        else:
            doctor_id = "DOC-" + secrets.token_urlsafe(18)
            try:
                connection.execute(
                    """
                    INSERT INTO doctors (id, name, email, password_salt, password_hash, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        doctor_id,
                        challenge["name"],
                        email,
                        challenge["password_salt"],
                        challenge["password_hash"],
                        now.isoformat(),
                    ),
                )
            except sqlite3.IntegrityError:
                connection.execute(
                    "DELETE FROM signup_verifications WHERE email = ?",
                    (email,),
                )
                failure_status = 409
                failure_message = "An account already exists for this Gmail address."
            else:
                connection.execute(
                    "DELETE FROM signup_verifications WHERE email = ?",
                    (email,),
                )
                doctor = connection.execute(
                    "SELECT id, name, email FROM doctors WHERE id = ?",
                    (doctor_id,),
                ).fetchone()

    if failure_message:
        raise HTTPException(status_code=failure_status, detail=failure_message)
    if doctor is None:
        raise HTTPException(
            status_code=500,
            detail="Email verification did not create an account. Please try again.",
        )

    create_session(doctor["id"], request, response)
    return {"doctor": doctor_response(doctor)}


@app.post("/auth/login")
def auth_login(credentials: DoctorCredentials, request: Request, response: Response):
    ensure_request_origin(request)
    if not credentials.password or len(credentials.password) > 256:
        raise HTTPException(status_code=401, detail="Email or password is incorrect.")
    email = credentials.email.strip().lower()
    with get_connection() as connection:
        doctor = connection.execute(
            "SELECT * FROM doctors WHERE email = ?",
            (email,),
        ).fetchone()
    if doctor is None:
        raise HTTPException(status_code=401, detail="Email or password is incorrect.")

    password_hash = hashlib.scrypt(
        credentials.password.encode("utf-8"),
        salt=bytes.fromhex(doctor["password_salt"]),
        n=2**14,
        r=8,
        p=1,
        dklen=64,
    )
    if not hmac.compare_digest(password_hash.hex(), doctor["password_hash"]):
        raise HTTPException(status_code=401, detail="Email or password is incorrect.")

    create_session(doctor["id"], request, response)
    return {"doctor": doctor_response(doctor)}


@app.post("/auth/logout")
def auth_logout(request: Request, response: Response):
    ensure_request_origin(request)
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        with get_connection() as connection:
            connection.execute(
                "DELETE FROM auth_sessions WHERE token_hash = ?",
                (token_hash,),
            )
    response.delete_cookie(
        key=SESSION_COOKIE,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="lax",
        path="/",
    )
    return {"message": "Signed out."}


@app.post("/visits")
def save_visit(visit: VisitRecord, request: Request):
    doctor = require_doctor(request)
    with get_connection() as connection:
        if visit.isNewPatient:
            reserve_new_patient_id(connection, visit, doctor["id"])
        cursor = connection.execute(
            """
            INSERT INTO visits
            (id, patient_id, name, visit_date, visit_type, age, gender,
             health_issue, prescribed_medication, tests_and_investigations,
             suggested_health_report_tests, notes, plan, report_image, created_at, doctor_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                patient_id = excluded.patient_id,
                name = excluded.name,
                visit_date = excluded.visit_date,
                visit_type = excluded.visit_type,
                age = excluded.age,
                gender = excluded.gender,
                health_issue = excluded.health_issue,
                prescribed_medication = excluded.prescribed_medication,
                tests_and_investigations = excluded.tests_and_investigations,
                suggested_health_report_tests = excluded.suggested_health_report_tests,
                notes = excluded.notes,
                plan = excluded.plan,
                report_image = excluded.report_image,
                created_at = excluded.created_at
            WHERE visits.doctor_id = excluded.doctor_id
            """,
            (
                visit.id,
                visit.patientId,
                visit.name,
                visit.date,
                visit.visitType,
                visit.age,
                visit.gender,
                visit.healthIssue,
                visit.prescribedMedication,
                visit.testsAndInvestigations,
                visit.suggestedHealthReportTests,
                visit.notes,
                visit.plan,
                visit.reportImage,
                visit.createdAt,
                doctor["id"],
            ),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=409, detail="Visit ID already belongs to another workspace.")

    return {
        "message": "Visit saved successfully",
        "visitId": visit.id,
        "patientId": visit.patientId,
    }


@app.get("/patients/{patient_id}/availability")
def check_patient_id_availability(patient_id: str, request: Request):
    doctor = require_doctor(request)
    if not patient_id.strip():
        raise HTTPException(status_code=400, detail="Enter a Patient ID to check.")
    with get_connection() as connection:
        exists = patient_id_exists(connection, doctor["id"], patient_id)
    return {"available": not exists}


@app.get("/visits")
def get_visits(request: Request):
    doctor = require_doctor(request)
    with get_connection() as connection:
        rows = connection.execute(
            "SELECT * FROM visits WHERE doctor_id = ? ORDER BY created_at DESC",
            (doctor["id"],),
        ).fetchall()

    return [serialize_visit(row) for row in rows]


@app.get("/patients/{patient_id}/visits")
def get_patient_visits(patient_id: str, request: Request):
    doctor = require_doctor(request)
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT *
            FROM visits
            WHERE doctor_id = ? AND patient_id = ?
            ORDER BY visit_date DESC, created_at DESC
            """,
            (doctor["id"], patient_id),
        ).fetchall()

    return [serialize_visit(row) for row in rows]


@app.post("/demo/visits")
def save_demo_visit(visit: VisitRecord):
    with get_connection() as connection:
        if visit.isNewPatient:
            reserve_new_patient_id(connection, visit, None)
        cursor = connection.execute(
            """
            INSERT INTO visits
            (id, patient_id, name, visit_date, visit_type, age, gender,
             health_issue, prescribed_medication, tests_and_investigations,
             suggested_health_report_tests, notes, plan, report_image, created_at, doctor_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(id) DO UPDATE SET
                patient_id = excluded.patient_id,
                name = excluded.name,
                visit_date = excluded.visit_date,
                visit_type = excluded.visit_type,
                age = excluded.age,
                gender = excluded.gender,
                health_issue = excluded.health_issue,
                prescribed_medication = excluded.prescribed_medication,
                tests_and_investigations = excluded.tests_and_investigations,
                suggested_health_report_tests = excluded.suggested_health_report_tests,
                notes = excluded.notes,
                plan = excluded.plan,
                report_image = excluded.report_image,
                created_at = excluded.created_at
            WHERE visits.doctor_id IS NULL
            """,
            (
                visit.id,
                visit.patientId,
                visit.name,
                visit.date,
                visit.visitType,
                visit.age,
                visit.gender,
                visit.healthIssue,
                visit.prescribedMedication,
                visit.testsAndInvestigations,
                visit.suggestedHealthReportTests,
                visit.notes,
                visit.plan,
                visit.reportImage,
                visit.createdAt,
            ),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=409, detail="Visit ID already belongs to another workspace.")
    return {
        "message": "Demo visit saved successfully",
        "visitId": visit.id,
        "patientId": visit.patientId,
    }


@app.get("/demo/patients/{patient_id}/availability")
def check_demo_patient_id_availability(patient_id: str):
    if not patient_id.strip():
        raise HTTPException(status_code=400, detail="Enter a Patient ID to check.")
    with get_connection() as connection:
        exists = patient_id_exists(connection, "__demo__", patient_id)
    return {"available": not exists}


@app.get("/demo/visits")
def get_demo_visits():
    with get_connection() as connection:
        rows = connection.execute(
            "SELECT * FROM visits WHERE doctor_id IS NULL ORDER BY created_at DESC"
        ).fetchall()
    return [serialize_visit(row) for row in rows]


@app.get("/demo/patients/{patient_id}/visits")
def get_demo_patient_visits(patient_id: str):
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT *
            FROM visits
            WHERE doctor_id IS NULL AND patient_id = ?
            ORDER BY visit_date DESC, created_at DESC
            """,
            (patient_id,),
        ).fetchall()
    return [serialize_visit(row) for row in rows]
