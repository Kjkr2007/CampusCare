
require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const helmet = require("helmet");
const session = require("express-session");
const SQLiteStoreFactory = require("connect-sqlite3")(session);
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const app = express();

const PORT = Number(process.env.PORT || 3000);

const allowedOrigins = [
  "https://campuscare-int219.netlify.app"
];

app.set("trust proxy", 1);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// ================= DATABASE SETUP =================

const DB_DIR = path.join(__dirname, "data");

fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(
  path.join(DB_DIR, "campuscare.sqlite")
);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK(id=1),
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// ================= INITIAL APPLICATION DATA =================

const initialState = {
  doctors: [
    {
      id: "doc_1",
      name: "Dr. Anjali Mehra",
      specialty: "General Physician",
      onDuty: true
    },
    {
      id: "doc_2",
      name: "Dr. Rohan Kapoor",
      specialty: "Orthopedics",
      onDuty: true
    },
    {
      id: "doc_3",
      name: "Dr. Simran Kaur",
      specialty: "Psychiatrist / Counsellor",
      onDuty: false
    }
  ],
  bookings: {},
  queue: [],
  nextToken: 1,
  nowServing: null,
  alerts: [],
  responders: [
    {
      id: "res_1",
      name: "Security Officer Verma",
      onDuty: true
    },
    {
      id: "res_2",
      name: "Nurse Latika",
      onDuty: true
    },
    {
      id: "res_3",
      name: "Warden Mr. Singh",
      onDuty: false
    }
  ],
  visits: []
};

const savedState = db.prepare(
  "SELECT id FROM app_state WHERE id=1"
).get();

if (!savedState) {
  db.prepare(
    "INSERT INTO app_state VALUES (1, ?, ?)"
  ).run(
    JSON.stringify(initialState),
    new Date().toISOString()
  );
}

// ================= ADMIN ACCOUNT =================

const adminUsername = (
  process.env.ADMIN_USERNAME || "admin"
).toLowerCase();

const adminPassword = process.env.ADMIN_PASSWORD;

if (!adminPassword || adminPassword.length < 12) {
  console.error(
    "Please set ADMIN_PASSWORD in .env (minimum 12 characters)."
  );
  process.exit(1);
}

const existingAdmin = db.prepare(
  "SELECT id FROM users WHERE username=?"
).get(adminUsername);

const newHash = bcrypt.hashSync(adminPassword, 12);

if (existingAdmin) {
  db.prepare(
    "UPDATE users SET password_hash=? WHERE username=?"
  ).run(newHash, adminUsername);
} else {
  db.prepare(
    "INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    "usr_admin",
    "Campus Administrator",
    adminUsername,
    newHash,
    "admin",
    new Date().toISOString()
  );
}

// ================= MIDDLEWARE =================

app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

// Parse JSON and form data BEFORE API routes
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

if (!process.env.SESSION_SECRET) {
  console.error("Please configure SESSION_SECRET in .env");
  process.exit(1);
}

// Session configuration
app.use(
  session({
    store: new SQLiteStoreFactory({
      db: "sessions.sqlite",
      dir: DB_DIR
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
  httpOnly: true,
  sameSite: "none",
  secure: true,
  maxAge: 8 * 60 * 60 * 1000
}
  })
);

// ================= AUTH HELPERS =================

const safeUser = user => ({
  id: user.id,
  name: user.name,
  username: user.username,
  role: user.role
});

const auth = (req, res, next) => {
  if (!req.session.user) {
    return res.status(401).json({
      error: "Please sign in first."
    });
  }

  next();
};

const admin = (req, res, next) => {
  if (!req.session.user) {
    return res.status(401).json({
      error: "Please sign in first."
    });
  }

  if (req.session.user.role !== "admin") {
    return res.status(403).json({
      error: "Administrator access required."
    });
  }

  next();
};

const readState = () => {
  const row = db.prepare(
    "SELECT state_json FROM app_state WHERE id=1"
  ).get();

  return JSON.parse(row.state_json);
};

// ================= LOGIN API =================

app.post("/api/auth/login", (req, res) => {
  const username = String(
    req.body?.username || ""
  ).trim().toLowerCase();

  const password = String(
    req.body?.password || ""
  );

  const user = db.prepare(
    "SELECT * FROM users WHERE username=?"
  ).get(username);

  if (
    !user ||
    !bcrypt.compareSync(password, user.password_hash)
  ) {
    return res.status(401).json({
      error: "Incorrect username or password."
    });
  }

  req.session.regenerate(err => {
    if (err) {
      return res.status(500).json({
        error: "Could not create session."
      });
    }

    req.session.user = safeUser(user);

    req.session.save(saveError => {
      if (saveError) {
        return res.status(500).json({
          error: "Could not save session."
        });
      }

      res.json({
        user: req.session.user
      });
    });
  });
});

// ================= CURRENT USER =================

app.get("/api/auth/me", auth, (req, res) => {
  res.json({
    user: req.session.user
  });
});

// ================= LOGOUT API =================

app.post("/api/auth/logout", auth, (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({
        error: "Could not log out."
      });
    }

    res.clearCookie("connect.sid", {
  httpOnly: true,
  sameSite: "none",
  secure: true,
  path: "/"
});

    res.json({
      ok: true
    });
  });
});

// ================= APPLICATION STATE API =================

app.get("/api/state", auth, (req, res) => {
  res.json(readState());
});

app.put("/api/state", auth, (req, res) => {
  const incoming = req.body || {};

  const allowed = [
    "doctors",
    "bookings",
    "queue",
    "nextToken",
    "nowServing",
    "alerts",
    "responders",
    "visits"
  ];

  const clean = {};

  for (const key of allowed) {
    if (incoming[key] !== undefined) {
      clean[key] = incoming[key];
    }
  }

  const merged = {
    ...readState(),
    ...clean
  };

  db.prepare(`
    UPDATE app_state
    SET state_json=?, updated_at=?
    WHERE id=1
  `).run(
    JSON.stringify(merged),
    new Date().toISOString()
  );

  res.json({
    ok: true
  });
});

// ================= USER MANAGEMENT API =================

// List accounts
app.get("/api/users", admin, (req, res) => {
  const users = db.prepare(`
    SELECT id, name, username, role
    FROM users
    ORDER BY created_at DESC
  `).all();

  res.json(users);
});

// Create account
app.post("/api/users", admin, (req, res) => {
  const name = String(
    req.body?.name || ""
  ).trim();

  const username = String(
    req.body?.username || ""
  ).trim().toLowerCase();

  const password = String(
    req.body?.password || ""
  );

  const role = String(
    req.body?.role || ""
  );

  if (name.length < 2 || name.length > 80) {
    return res.status(400).json({
      error: "Name must be 2–80 characters."
    });
  }

  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return res.status(400).json({
      error: "Invalid username."
    });
  }

  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({
      error: "Password must be at least 8 characters."
    });
  }

  if (
    !["student", "responder", "doctor", "admin"].includes(role)
  ) {
    return res.status(400).json({
      error: "Invalid account role."
    });
  }

  const exists = db.prepare(
    "SELECT id FROM users WHERE username=?"
  ).get(username);

  if (exists) {
    return res.status(409).json({
      error: "Username already exists."
    });
  }

  const id = "usr_" + crypto.randomBytes(8).toString("hex");

  const passwordHash = bcrypt.hashSync(password, 12);

  db.prepare(
    "INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    name,
    username,
    passwordHash,
    role,
    new Date().toISOString()
  );

  res.status(201).json({
    user: {
      id,
      name,
      username,
      role
    }
  });
});

// Delete account
app.delete("/api/users/:id", admin, (req, res) => {
  if (req.params.id === req.session.user.id) {
    return res.status(400).json({
      error: "You cannot delete your own account."
    });
  }

  const result = db.prepare(`
    DELETE FROM users
    WHERE id=? AND username<>?
  `).run(
    req.params.id,
    adminUsername
  );

  if (!result.changes) {
    return res.status(404).json({
      error: "Account not found or protected."
    });
  }

  res.json({
    ok: true
  });
});

// ================= HEALTH CHECK =================

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "CampusCare API"
  });
});

// ================= FRONTEND HOSTING =================



// ================= START SERVER =================

app.listen(PORT, () => {
  console.log(
    `CampusCare running at http://localhost:${PORT}`
  );
});
