#!/usr/bin/env bash
# FitX Call — one-command setup on the FREE Firebase plan (Spark). No key file, no billing.
# Run in https://shell.cloud.google.com :
#   bash <(curl -fsSL https://raw.githubusercontent.com/fitxqa/fitx-call/main/cloudshell-setup.sh)
set -u
P=studio-1166518588-1f04b
REGION=europe-west1
DOMAIN=fitxcall.local
RAW=https://raw.githubusercontent.com/fitxqa/fitx-call/main
say()  { printf '\n\033[1;33m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m✔ %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31m✗ %s\033[0m\n' "$1"; exit 1; }

gcloud config set project "$P" >/dev/null 2>&1
TOKEN=$(gcloud auth print-access-token 2>/dev/null) || fail "Not signed in. Run:  gcloud auth login   then run this command again."
H=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "X-Goog-User-Project: $P")
api() { curl -sS "${H[@]}" "$@"; }

say "1/5  Turning on free services (Firestore, Login, Rules)"
gcloud services enable firestore.googleapis.com identitytoolkit.googleapis.com firebaserules.googleapis.com --project "$P" \
  || fail "Could not turn on services. Is this the Google account that owns the Firebase project?"
ok "Services on"

say "2/5  Database"
if gcloud firestore databases describe --database='(default)' --project "$P" >/dev/null 2>&1; then
  ok "Firestore database already exists"
else
  gcloud firestore databases create --location="$REGION" --project "$P" >/dev/null || fail "Could not create the database. Create it in Firebase console → Firestore Database → Create database (europe-west1), then run this again."
  ok "Firestore database created ($REGION)"
fi

say "3/5  Username + password sign-in"
R=$(api -X PATCH "https://identitytoolkit.googleapis.com/admin/v2/projects/$P/config?updateMask=signIn.email.enabled,signIn.email.passwordRequired" \
  -d '{"signIn":{"email":{"enabled":true,"passwordRequired":true}}}')
if echo "$R" | grep -q '"error"'; then
  echo "Couldn't switch it on automatically. Please do it once by hand:"
  echo "  Firebase console → Authentication → Get started → Email/Password → Enable → Save"
  read -r -p "Press Enter when done… " _
else ok "Sign-in switched on"; fi

say "4/5  Security rules"
RULES=$(curl -fsSL "$RAW/firestore.rules") || fail "Could not download the rules"
BODY=$(python3 -c 'import json,sys; print(json.dumps({"source":{"files":[{"name":"firestore.rules","content":sys.stdin.read()}]}}))' <<<"$RULES")
RS=$(api -X POST "https://firebaserules.googleapis.com/v1/projects/$P/rulesets" -d "$BODY" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("name") or ("ERR " + json.dumps(d.get("error",d))))')
case "$RS" in ERR*) fail "Rules were rejected: $RS";; esac
REL="projects/$P/releases/cloud.firestore"
R=$(api -X PATCH "https://firebaserules.googleapis.com/v1/$REL" -d "{\"release\":{\"name\":\"$REL\",\"rulesetName\":\"$RS\"}}")
if echo "$R" | grep -q '"error"'; then
  R=$(api -X POST "https://firebaserules.googleapis.com/v1/projects/$P/releases" -d "{\"name\":\"$REL\",\"rulesetName\":\"$RS\"}")
  echo "$R" | grep -q '"error"' && fail "Could not publish rules: $R"
fi
ok "Security rules published"

say "5/5  Your admin login for the app"
read -r -p "Admin username [admin]: " AU; AU=$(echo "${AU:-admin}" | tr 'A-Z' 'a-z' | tr -d ' ')
echo "$AU" | grep -Eq '^[a-z0-9._-]{3,30}$' || fail "Username must be 3-30 lowercase letters/numbers"
while true; do
  read -r -s -p "Admin password (6+ characters, nothing shows while typing): " AP; echo
  [ ${#AP} -ge 6 ] && break; echo "Too short, try again."
done
read -r -p "Your name [FitX Admin]: " AN; AN=${AN:-FitX Admin}

export P AU AP AN DOMAIN TOKEN
python3 - <<'PY' || exit 1
import json, os, urllib.request, urllib.error
P, AU, AP, AN, DOMAIN, TOKEN = (os.environ[k] for k in ["P","AU","AP","AN","DOMAIN","TOKEN"])
H = {"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json", "X-Goog-User-Project": P}
def call(method, url, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=H, method=method)
    try:
        with urllib.request.urlopen(req) as r: return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return {"error": json.loads(e.read() or b"{}").get("error", {"message": str(e)})}
IT = f"https://identitytoolkit.googleapis.com/v1/projects/{P}"
email = f"{AU}@{DOMAIN}"
look = call("POST", f"{IT}/accounts:lookup", {"email": [email]})
if look.get("users"):
    uid = look["users"][0]["localId"]
    r = call("POST", f"{IT}/accounts:update", {"localId": uid, "password": AP, "disableUser": False, "displayName": AN})
    if "error" in r: raise SystemExit("✗ Could not reset password: " + json.dumps(r["error"]))
    print("✔ Admin login already existed — password updated")
else:
    r = call("POST", f"{IT}/accounts", {"email": email, "password": AP, "displayName": AN})
    if "error" in r: raise SystemExit("✗ Could not create admin login: " + json.dumps(r["error"]))
    uid = r["localId"]
    print("✔ Admin login created")
FS = f"https://firestore.googleapis.com/v1/projects/{P}/databases/(default)/documents"
s = lambda v: {"stringValue": v}
r = call("PATCH", f"{FS}/users/{uid}", {"fields": {"name": s(AN), "username": s(AU), "department": s("Management"),
                                                   "role": s("admin"), "disabled": {"booleanValue": False}}})
if "error" in r: raise SystemExit("✗ Could not save admin profile: " + json.dumps(r["error"]))
r = call("PATCH", f"{FS}/usernames/{AU}", {"fields": {"email": s(email), "uid": s(uid)}})
if "error" in r: raise SystemExit("✗ Could not save username: " + json.dumps(r["error"]))
print("✔ Admin profile saved")
PY

printf '\n\033[1;32m==========================================\n ALL DONE ✔  (free plan, no billing)\n==========================================\033[0m\n'
echo "1. Install the app:  https://github.com/fitxqa/fitx-call/releases/latest"
echo "2. Sign in with username:  $AU   and the password you just typed"
echo "3. Admin tab → add your employees"
