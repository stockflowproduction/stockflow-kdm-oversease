import { auth, db } from './firebase';
import { AppState, StoreProfile } from '../types';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  User
} from 'firebase/auth';
import { doc, setDoc, getDoc } from 'firebase/firestore';

const GENERIC_AUTH_ERROR = 'Unable to complete the request. Please check your credentials and try again.';
const GENERIC_RESET_RESPONSE = 'If the email exists, a password reset link has been sent.';

const defaultStoreProfile: StoreProfile = {
  storeName: 'StockFlow Store',
  ownerName: '',
  gstin: '',
  email: '',
  phone: '',
  addressLine1: '',
  addressLine2: '',
  state: '',
  defaultTaxRate: 0,
  defaultTaxLabel: 'None',
  invoiceFormat: 'standard',
  adminPin: '1234',
};

const buildInitialStoreDocument = (user: User, fallbackName?: string): Partial<AppState> => {
  const ownerName = (fallbackName || user.displayName || user.email?.split('@')[0] || '').trim();
  const inferredStoreName = ownerName ? `${ownerName}'s Store` : defaultStoreProfile.storeName;

  return {
    categories: [],
    profile: {
      ...defaultStoreProfile,
      ownerName,
      email: user.email || '',
      storeName: inferredStoreName,
    },
    upfrontOrders: [],
    cashSessions: [],
    expenses: [],
    expenseCategories: ['General'],
    expenseActivities: [],
    freightInquiries: [],
    freightConfirmedOrders: [],
    freightPurchases: [],
    purchaseReceiptPostings: [],
    freightBrokers: [],
    purchaseParties: [],
    purchaseOrders: [],
    variantsMaster: [],
    colorsMaster: [],
  };
};

const ensureUserDoc = async (user: User, fallbackName?: string) => {
  if (!db) return;
  const userDocRef = doc(db, 'users', user.uid);
  const userDoc = await getDoc(userDocRef);
  if (!userDoc.exists()) {
    await setDoc(userDocRef, {
      uid: user.uid,
      email: user.email,
      name: (fallbackName || user.displayName || user.email?.split('@')[0] || '').trim(),
      createdAt: new Date().toISOString(),
    });
  }
};

const getStoreDocStatus = async (user: User): Promise<'ready' | 'missing_store'> => {
  if (!db) return 'ready';
  const storeDoc = await getDoc(doc(db, 'stores', user.uid));
  return storeDoc.exists() ? 'ready' : 'missing_store';
};

export const getCurrentUserProvisioningState = async (): Promise<'unauthenticated' | 'unverified' | 'ready' | 'missing_store'> => {
  const user = auth?.currentUser;
  if (!user) return 'unauthenticated';
  if (!user.emailVerified) return 'unverified';
  return getStoreDocStatus(user);
};

export const getCurrentUser = (): string | null => {
  return auth?.currentUser?.email || null;
};

if (auth) {
  onAuthStateChanged(auth, () => {
    // intentionally no business/session local persistence for incident hardening
  });
}

export const login = async (email: string, password: string): Promise<{ success: boolean; message?: string; requiresVerification?: boolean; recoveryRequired?: boolean }> => {
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

    await ensureUserDoc(user, email.split('@')[0]);

    const storeStatus = await getStoreDocStatus(user);
    if (storeStatus === 'missing_store') {
      return {
        success: true,
        recoveryRequired: true,
        message: 'Your account is verified, but the store document is missing. Use Recover Store to safely recreate the required store shell.'
      };
    }

    return { success: true };
  } catch (error: any) {
    console.error('Firebase Login Error:', error);
    return { success: false, message: GENERIC_AUTH_ERROR };
  }
};

export const register = async (email: string, password: string, name: string): Promise<{ success: boolean; message?: string; recoveryRequired?: boolean }> => {
  if (!auth) return { success: false, message: 'Firebase not configured.' };

  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

    if (db) {
      await setDoc(doc(db, 'users', user.uid), {
        uid: user.uid,
        name,
        email,
        createdAt: new Date().toISOString()
      });
    }

    await sendEmailVerification(user);

    await signOut(auth);

    return { success: true };
  } catch (error: any) {
    console.error('Firebase Register Error:', error);
    if (error.code === 'auth/email-already-in-use') {
      try {
        const existingCredential = await signInWithEmailAndPassword(auth, email, password);
        const existingUser = existingCredential.user;
        if (!existingUser.emailVerified) {
          await signOut(auth);
          return { success: false, message: 'This account already exists but the email is not verified yet. Please verify it or use resend verification.' };
        }
        await ensureUserDoc(existingUser, name);
        const storeStatus = await getStoreDocStatus(existingUser);
        await signOut(auth);
        if (storeStatus === 'missing_store') {
          return {
            success: false,
            recoveryRequired: true,
            message: 'This verified account already exists, but its store document is missing. Log in and use Recover Store instead of creating a new account.'
          };
        }
      } catch (inspectError: any) {
        if (inspectError?.code !== 'auth/wrong-password' && inspectError?.code !== 'auth/invalid-credential') {
          console.error('Firebase Register Conflict Inspection Error:', inspectError);
        }
      }
      return { success: false, message: 'This account already exists. Please log in instead of registering again.' };
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

export const recoverMissingStoreForCurrentUser = async (): Promise<{ success: boolean; message?: string }> => {
  const user = auth?.currentUser;
  if (!auth || !db || !user) return { success: false, message: 'Please log in again to recover the store.' };
  if (!user.emailVerified) return { success: false, message: 'Verify your email before recovering the store.' };

  try {
    await ensureUserDoc(user);
    const storeDocRef = doc(db, 'stores', user.uid);
    const storeDoc = await getDoc(storeDocRef);
    if (!storeDoc.exists()) {
      await setDoc(storeDocRef, buildInitialStoreDocument(user), { merge: false });
    }
    return { success: true, message: 'Store shell recovered. Reloading live data…' };
  } catch (error: any) {
    console.error('Firebase Store Recovery Error:', error);
    return { success: false, message: error?.message || 'Unable to recover the store right now.' };
  }
};
