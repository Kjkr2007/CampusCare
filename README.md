# CampusCare — light hospital theme + login + admin user management

## Run
Open `index.html` in a browser, preferably with VS Code Live Server.

## Demo administrator login
Username: `admin`
Password: `admin123`

After signing in, open **User Management** to create Student, Responder / Health Staff, Doctor, or Admin accounts. Doctor accounts are added to the doctor list; responder accounts are added to the responder list.

## Files
- `index.html` — login page, original app sections and admin panel
- `style.css` — fixed light hospital/clinical theme
- `script.js` — original campus health functionality plus demo sign-in and account management

## Security warning
This is a front-end demonstration only. Passwords are stored in plain text in browser localStorage and can be inspected or changed by anyone with browser access. It is not secure authentication and must not be used for real patient or staff data. A real deployment requires server-side authentication, password hashing, secure sessions, server-enforced roles, HTTPS, database storage, audit logs and privacy safeguards. Emergency alerts do not contact actual responders.
