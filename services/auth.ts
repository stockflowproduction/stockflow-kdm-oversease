import { auth, db } from './firebase';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail
} from 'firebase/auth';
import { doc, setDoc, getDoc } from 'firebase/firestore';

const GENERIC_AUTH_ERROR = 'Unable to complete the request. Please check your credentials and try again.';
const GENERIC_RESET_RESPONSE = 'If the email exists, a password reset link has been sent.';

export const getCurrentUser = (): string | null => {
  return auth?.currentUser?.email || null;
};

if (auth) {
  onAuthStateChanged(auth, () => {
    // intentionally no business/session local persistence for incident hardening
  });
}

export const login = async (email: string, password: string): Promise<{ success: boolean; message?: string; requiresVerification?: boolean }> => {
  if (!auth) return { success: false, message: 'Firebase not configured.' };

  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

    if (!user.emailVerified) {
      await signOut(auth);
      return {
        success: false,
        requiresVerification: true,
        message: 'Your email address is not verified. Please verify your email before logging in.'
      };
    }

    if (db) {
      const userDocRef = doc(db, 'users', user.uid);
      const userDoc = await getDoc(userDocRef);

      if (!userDoc.exists()) {
        await setDoc(userDocRef, {
          uid: user.uid,
          email: user.email,
          name: user.displayName || email.split('@')[0],
          createdAt: new Date().toISOString(),
          role: 'admin'
        });
      }
    }

    return { success: true };
  } catch (error: any) {
    console.error('Firebase Login Error:', error);
    return { success: false, message: GENERIC_AUTH_ERROR };
  }
};

export const register = async (email: string, password: string, name: string): Promise<{ success: boolean; message?: string }> => {
  if (!auth) return { success: false, message: 'Firebase not configured.' };

  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

    if (db) {
      await setDoc(doc(db, 'users', user.uid), {
        uid: user.uid,
        name,
        email,
        createdAt: new Date().toISOString(),
        role: 'admin'
      });
    }

    await sendEmailVerification(user);

    await signOut(auth);

    return { success: true };
  } catch (error: any) {
    console.error('Firebase Register Error:', error);
    if (error.code === 'auth/email-already-in-use') {
      return { success: false, message: 'Unable to complete the request. Please use a different email or log in.' };
    }
    return { success: false, message: GENERIC_AUTH_ERROR };
  }
};

export const resetPassword = async (email: string): Promise<{ success: boolean; message?: string }> => {
  if (!auth) return { success: false, message: 'Firebase not configured.' };

  try {
    await sendPasswordResetEmail(auth, email);
    return { success: true, message: GENERIC_RESET_RESPONSE };
  } catch (error: any) {
    console.error('Firebase Reset Password Error:', error);
    return { success: true, message: GENERIC_RESET_RESPONSE };
  }
};

export const resendVerificationEmail = async (email: string, password: string): Promise<{ success: boolean; message?: string }> => {
  if (!auth) return { success: false, message: 'Firebase not configured.' };

  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

    if (!user.emailVerified) {
      await sendEmailVerification(user);
    }

    await signOut(auth);
    return { success: true, message: 'If the email address is valid, a verification link has been sent.' };
  } catch (error: any) {
    console.error('Firebase Resend Verification Error:', error);
    return { success: true, message: 'If the email address is valid, a verification link has been sent.' };
  }
};

export const logout = async () => {
  if (auth) {
    await signOut(auth);
  }
  window.location.reload();
};
