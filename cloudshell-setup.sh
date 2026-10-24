#!/usr/bin/env bash
# FitX Call — one-command backend setup for Google Cloud Shell (no key file needed).
# Run in https://shell.cloud.google.com :
#   bash <(curl -fsSL https://raw.githubusercontent.com/fitxqa/fitx-call/main/cloudshell-setup.sh)
set -e
P=studio-1166518588-1f04b
REGION=europe-west1
say() { printf '\n\033[1;33m==> %s\033[0m\n' "$1"; }

say "Using Firebase project $P"
gcloud config set project "$P" >/dev/null 2>&1

say "Turning on the Google services the app needs (1-2 min)"
gcloud services enable firestore.googleapis.com identitytoolkit.googleapis.com cloudfunctions.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com run.googleapis.com eventarc.googleapis.com \
  pubsub.googleapis.com fcm.googleapis.com firebaseinstallations.googleapis.com --project "$P" || {
  echo; echo "!! Could not enable services. Make sure the project is on the Blaze plan:"
  echo "   https://console.firebase.google.com/project/$P/usage/details"; exit 1; }

say "Checking the Firestore database"
if ! gcloud firestore databases describe --database='(default)' --project "$P" >/dev/null 2>&1; then
  gcloud firestore databases create --location="$REGION" --project "$P"
fi

say "Turning on username/password sign-in"
TOKEN=$(gcloud auth print-access-token)
curl -fsS -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "X-Goog-User-Project: $P" \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/$P/config?updateMask=signIn.email" \
  -d '{"signIn":{"email":{"enabled":true,"passwordRequired":true}}}' >/dev/null \
  && echo "Email/Password sign-in enabled" \
  || echo "(If logins fail later: Firebase console → Authentication → Sign-in method → Email/Password → Enable)"

say "Downloading FitX Call"
cd ~ && rm -rf fitx-call && git clone -q --depth 1 https://github.com/fitxqa/fitx-call && cd fitx-call
(cd functions && npm install --omit=dev --no-audit --no-fund --silent)

say "Deploying security rules + call ringing + admin functions (3-5 min)"
FB="npx -y firebase-tools@latest"
if ! $FB projects:list >/dev/null 2>&1; then
  echo "Firebase needs you to sign in once. Open the link it shows, approve, and paste the code back here."
  $FB login --no-localhost
fi
$FB deploy --only firestore,functions --project "$P" --non-interactive --force || {
  echo; echo "Deploy failed once — this is normal on a brand-new project. Retrying in 60 seconds…"; sleep 60
  $FB deploy --only firestore,functions --project "$P" --non-interactive --force; }

say "Create your admin login for the app"
read -r -p "Admin username [admin]: " AU; AU=${AU:-admin}
while true; do
  read -r -s -p "Admin password (6+ characters): " AP; echo
  [ ${#AP} -ge 6 ] && break; echo "Too short, try again."
done
(cd functions && GOOGLE_CLOUD_PROJECT="$P" GCLOUD_PROJECT="$P" ADMIN_USERNAME="$AU" ADMIN_PASSWORD="$AP" ADMIN_NAME="FitX Admin" node create-admin.js)

say "ALL DONE ✔  Install the app and sign in as: $AU"
echo "APK: https://github.com/fitxqa/fitx-call/releases/latest"
