const admin = require('firebase-admin');

function initFirebaseAdmin() {
  try {
    if (admin.apps.length > 0) return admin;

    // Use base64 service account if available
    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
      const serviceAccount = JSON.parse(
        Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
      );
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log('[FirebaseAdmin] Initialized via BASE64');
    } 
    // Or use individual env variables
    else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          // Replace escaped newlines so the key works correctly
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        })
      });
      console.log('[FirebaseAdmin] Initialized via Env Vars');
    } else {
      console.warn('[FirebaseAdmin] Warning: Missing Firebase Admin credentials in ENV.');
    }
  } catch (error) {
    console.error('[FirebaseAdmin] Error initializing Firebase Admin:', error);
  }
  return admin;
}

const firebaseAdmin = initFirebaseAdmin();

/**
 * Send an FCM message to a user device
 */
async function sendFCMMessage(token, payload) {
  if (!firebaseAdmin || firebaseAdmin.apps.length === 0) {
    console.log('[FirebaseAdmin] Admin not initialized, skipping FCM.');
    return;
  }
  try {
    const response = await firebaseAdmin.messaging().send({
      token,
      ...payload,
    });
    console.log('[FirebaseAdmin] Successfully sent message:', response);
    return response;
  } catch (error) {
    console.error('[FirebaseAdmin] Error sending message to token', token, ':', error);
    // If token is invalid/unregistered, return the error so we can delete it
    throw error;
  }
}

module.exports = {
  firebaseAdmin,
  sendFCMMessage
};
