# Admin Authentication — Options

Approaches for protecting `/admin/apps` and `/admin/api/apps` routes.
No complex user management. Goal: simple, non-dev-friendly login.

---

## Option A: IP Whitelist

Admin routes only accessible from specific IPs (office network, VPN).
No login needed — if you're on the right network, you're in.

**Pros:**
- Zero UI, zero passwords, zero maintenance
- Invisible to the user — just works if you're on the right network

**Cons:**
- Remote workers can't access without VPN
- Need to update IP list when office network changes
- Not practical if team is fully remote

**Implementation:** Middleware checks `req.ip` against a list stored in MongoDB `settings` collection.

---

## Option B: OAuth via Google / GitHub

"Login with Google" button on admin page. Restrict to specific email domains
(e.g. `@yourcompany.com`) or specific email addresses.

**Pros:**
- Users just click one button — no passwords to remember
- Restrict by email domain or whitelist specific emails
- Secure — delegated to Google/GitHub's auth infrastructure

**Cons:**
- Needs a Google OAuth client ID (free, one-time setup in Google Cloud Console)
- Requires internet access (external dependency)
- More implementation work (OAuth flow, callback route, session management)

**Implementation:**
- Use `passport.js` with `passport-google-oauth20` strategy
- Allowed emails/domains stored in MongoDB `settings` collection
- Session stored as a signed cookie (no session store needed)

---

## Option C: Magic Link via Email

Admin page has an email input. Enter email → server sends a login link
with a temporary token → click link → session cookie set.

**Pros:**
- No password to remember
- Secure — link expires in 10 minutes
- Allowed emails stored in MongoDB

**Cons:**
- Needs an email service (SendGrid, Mailgun, SMTP, etc.)
- Extra infrastructure dependency
- Slight delay — user waits for email

**Implementation:**
- Generate random token, store in Redis with 10min TTL
- Send email with `https://your-domain/admin/auth/verify?token=xxx`
- On click: validate token, set session cookie, delete token

---

## Option D: First-Visit Setup + Password Login (Fallback Plan)

On first server start, admin page shows "Set Admin Password" form.
Password saved to MongoDB (bcrypt hashed). After that, admin page shows
a login form. On correct password, session cookie is set.

**Pros:**
- No env vars needed
- Works offline, no external dependencies
- First visitor sets the password — self-service setup
- Change password from the admin page itself

**Cons:**
- Shared password for all admin users — no individual accountability
- Password can be lost (need a reset mechanism)
- First-visitor-sets-password could be exploited if server is exposed before setup

**Implementation:**
- `settings` collection: `{ key: "adminPasswordHash", value: "bcrypt..." }`
- Login page sets a signed cookie (`cookie-parser` already installed)
- Cookie expires after 24hrs
- Middleware checks cookie on all `/admin/*` routes (except `/admin/auth/*`)
- "Change password" form on admin page

---

## Recommendation

**For internal/VPN environments:** Option A (IP whitelist) — zero friction.
**For teams with Google Workspace:** Option B (OAuth) — best UX, most secure.
**For simplest standalone setup:** Option D (password) — no external deps.

Decision pending — discuss with team before implementing.
