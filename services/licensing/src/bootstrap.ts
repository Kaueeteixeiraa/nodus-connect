import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
const uid = process.argv[2]; const projectId = process.env.GCLOUD_PROJECT;
if (!uid || !projectId || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new Error("BOOTSTRAP_REQUIRES_PROJECT_AND_EXISTING_UID");
initializeApp({ projectId, ...(process.env.FIREBASE_AUTH_EMULATOR_HOST ? {} : { credential: applicationDefault() }) });
const auth = getAuth(); const user = await auth.getUser(uid);
if (user.disabled || !user.emailVerified || !user.providerData.length) throw new Error("BOOTSTRAP_REQUIRES_VERIFIED_NON_ANONYMOUS_ACCOUNT");
await getFirestore().runTransaction(async tx => {
  const ref = getFirestore().doc("license_policy/bootstrap"); const marker = await tx.get(ref);
  if (marker.exists && marker.data()?.uid !== uid) throw new Error("BOOTSTRAP_ALREADY_COMPLETED");
  tx.set(ref, { uid, timestamp: Date.now() }); tx.set(getFirestore().doc(`license_admins/${uid}`), { role: "SUPER_ADMIN", status: "ACTIVE", createdAt: Date.now() });
});
await auth.setCustomUserClaims(uid, { ...user.customClaims, role: "SUPER_ADMIN" });
await auth.revokeRefreshTokens(uid);
console.log("SUPER_ADMIN configured. Sign in again; no public admin registration exists.");
