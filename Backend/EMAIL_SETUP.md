# Gmail verification setup

Doctor signup checks that an address is a valid `@gmail.com` address, rejects
addresses already used by an account (including Gmail dot/plus aliases), and
requires an 8-digit code sent to that inbox before creating the account.

## Configure Gmail SMTP

1. Enable 2-Step Verification on the Gmail account that will send verification
   emails.
2. Create a Google App Password for MediSync. Use the app password, not the
   Gmail account password.
3. Copy `.env.example` to `.env` in this folder and set:
   - `SMTP_USERNAME` to the sending Gmail address.
   - `SMTP_PASSWORD` to its Google App Password.
   - `SMTP_FROM_EMAIL` to the same sending address.
4. Restart MediSync with `run_app.bat`.

Keep `Backend/.env` private. It is excluded by `Backend/.gitignore`; never put
email credentials in frontend files or share them in chat.

Signup codes expire after 10 minutes, can be resent once per minute, and allow
up to five attempts. Without SMTP configuration, signup returns an explicit
configuration error and does not create an account.
