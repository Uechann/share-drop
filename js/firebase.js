import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";

// Firebase 클라이언트 설정
// ※ apiKey는 비밀키가 아니라 "프로젝트 식별자"로, 클라이언트에 공개되는 것이 정상입니다.
//   실제 접근 제어는 Firestore Security Rules(firestore.rules)가 담당합니다.
//   참고: https://firebase.google.com/docs/projects/api-keys
const firebaseConfig = {
    apiKey: "AIzaSyBfoJZbQtBzIwuEc03tOxOv-j0ClpfMZJs",
    authDomain: "share-drop-621d1.firebaseapp.com",
    projectId: "share-drop-621d1",
    storageBucket: "share-drop-621d1.firebasestorage.app",
    messagingSenderId: "701042467898",
    appId: "1:701042467898:web:47ea8704b52c2909920103",
    measurementId: "G-PH9QRWN34T"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// 익명 인증 시도.
// - 콘솔에서 Anonymous 로그인이 활성화되어 있으면: 브라우저별 고유 uid 반환
//   → Security Rules가 이 uid로 소유권(방장/업로더)을 서버 측에서 강제할 수 있음
// - 아직 비활성 상태면: null 반환 → 앱은 localStorage 기반 ID로 폴백 (규칙 적용 전까지의 과도기)
export async function ensureAnonymousUser() {
    try {
        const cred = await signInAnonymously(auth);
        return cred.user.uid;
    } catch (e) {
        console.warn('익명 인증을 사용할 수 없어 localStorage ID로 폴백합니다:', e.code);
        return null;
    }
}
