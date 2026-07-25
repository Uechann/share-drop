import {
    collection, doc, setDoc, getDoc, onSnapshot,
    addDoc, serverTimestamp, query, orderBy, deleteDoc, getDocs, updateDoc, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { db, ensureAnonymousUser } from './firebase.js';
import {
    escapeHtml, sha256, dataUrlToFile, generateRoomCode,
    getFormatFromMime, getFormatBadgeColor, readAsDataURL, compressImage
} from './utils.js';

// 앱 전역 상태
let currentRoomId = null;
let currentRoomData = null;
let unsubscribeRoom = null;
let unsubscribeImages = null;
let imagesData = [];
let selectedImageIds = new Set();
let myUserId = '';
let myUserName = '';
let currentFolder = null; // 현재 보고 있는 폴더 (null = 전체)
let currentFilteredImages = []; // 현재 필터가 적용된 목록 (범위선택/전체선택용)
let lastSelectedIndex = null;   // Shift 범위 선택 기준점
let pendingMoveIds = null;      // '새 폴더 만들어 이동' 대기 중인 선택 항목
const RENDER_CHUNK = 30;        // 대규모 방 대비 점진 렌더링 단위
let renderLimit = RENDER_CHUNK;

// 터치 기기 여부 + Web Share API(파일) 지원 여부 → 사진첩 저장 경로
const isTouchDevice = window.matchMedia('(hover: none)').matches;

// Web Share API(파일 공유) 사용 가능 여부.
// ※ 과거엔 '빈 File'로 canShare()를 미리 검사했는데, 일부 안드로이드(삼성 갤럭시 등)는
//   크기 0인 파일에 false를 반환해 사진첩 저장 기능이 통째로 비활성화되는 버그가 있었다.
//   이제 API 존재 여부만 확인하고, 실제 공유 가능 여부는 호출 시점에 '진짜 파일'로 검사한다.
const canShareFiles = isTouchDevice
    && typeof navigator.share === 'function'
    && typeof navigator.canShare === 'function';

// 호출 시점에 실제 파일로 공유 가능한지 확인
function canShareTheseFiles(files) {
    try {
        return typeof navigator.canShare === 'function' && navigator.canShare({ files });
    } catch (e) {
        return false;
    }
}

// 업로드 진행 상태 관리
const uploadTasks = new Map(); // taskId -> { id, file, status: waiting|uploading|done|error }
let uploadTaskSeq = 0;
let uploadQueueRunning = false;

// DOM 요소 캐싱
const els = {
    viewHome: document.getElementById('view-home'),
    viewRoom: document.getElementById('view-room'),

    // Home Inputs
    inputRoomName: document.getElementById('input-room-name'),
    inputUserName: document.getElementById('input-user-name'),
    inputRoomPassword: document.getElementById('input-room-password'),
    selectExpiry: document.getElementById('select-expiry'),
    selectPermission: document.getElementById('select-permission'),
    btnCreateRoom: document.getElementById('btn-create-room'),
    inputJoinCode: document.getElementById('input-join-code'),
    btnJoinRoom: document.getElementById('btn-join-room'),

    // Room UI
    btnGoHome: document.getElementById('btn-go-home'),
    uiRoomName: document.getElementById('ui-room-name'),
    uiRoomCode: document.getElementById('ui-room-code'),
    uiCountdown: document.getElementById('ui-countdown'),
    uiOwnerBadge: document.getElementById('ui-owner-badge'),
    btnCopyLink: document.getElementById('btn-copy-link'),
    btnDeleteRoom: document.getElementById('btn-delete-room'),
    btnRoomSettings: document.getElementById('btn-room-settings'),

    // Settings Modal
    settingsModal: document.getElementById('settings-modal'),
    settingsName: document.getElementById('settings-name'),
    settingsExpiry: document.getElementById('settings-expiry'),
    settingsPermission: document.getElementById('settings-permission'),
    settingsPassword: document.getElementById('settings-password'),
    settingsRemovePassword: document.getElementById('settings-remove-password'),
    settingsCancel: document.getElementById('settings-cancel'),
    settingsSave: document.getElementById('settings-save'),

    // Nickname & Password Modals
    nicknameModal: document.getElementById('nickname-modal'),
    nicknameInput: document.getElementById('nickname-input'),
    nicknameConfirm: document.getElementById('nickname-confirm'),
    passwordModal: document.getElementById('password-modal'),
    passwordInput: document.getElementById('password-input'),
    passwordConfirm: document.getElementById('password-confirm'),
    passwordCancel: document.getElementById('password-cancel'),

    // Upload & Drop
    inputFile: document.getElementById('input-file'),
    btnUploadWrapper: document.getElementById('btn-upload-wrapper'),
    dropZone: document.getElementById('drop-zone'),
    dragOverlay: document.getElementById('drag-overlay'),

    // Upload Panel
    uploadPanel: document.getElementById('upload-panel'),
    uploadPanelTitle: document.getElementById('upload-panel-title'),
    uploadPanelClose: document.getElementById('upload-panel-close'),
    uploadProgressBar: document.getElementById('upload-progress-bar'),
    uploadList: document.getElementById('upload-list'),

    // Folders
    folderChips: document.getElementById('folder-chips'),
    btnNewFolder: document.getElementById('btn-new-folder'),
    inputNewFolder: document.getElementById('input-new-folder'),
    moveFolder: document.getElementById('move-folder'),

    // Filters & Actions
    filterUploader: document.getElementById('filter-uploader'),
    filterFormat: document.getElementById('filter-format'),
    btnSelectAll: document.getElementById('btn-select-all'),
    selectionActions: document.getElementById('selection-actions'),
    btnUnselectAll: document.getElementById('btn-unselect-all'),
    btnDeleteSelected: document.getElementById('btn-delete-selected'),
    btnSavePhotos: document.getElementById('btn-save-photos'),
    btnDownloadSelected: document.getElementById('btn-download-selected'),
    uiSelectedCount: document.getElementById('ui-selected-count'),

    // Gallery
    galleryGrid: document.getElementById('gallery-grid'),
    emptyState: document.getElementById('empty-state'),
    loadMoreWrap: document.getElementById('load-more-wrap'),
    btnLoadMore: document.getElementById('btn-load-more'),
    loadMoreCount: document.getElementById('load-more-count'),
    marquee: document.getElementById('marquee'),

    // Lightbox
    lightbox: document.getElementById('lightbox'),
    lightboxImg: document.getElementById('lightbox-img'),
    lightboxVideo: document.getElementById('lightbox-video'),
    lightboxClose: document.getElementById('lightbox-close'),
    lightboxInfo: document.getElementById('lightbox-info'),
    lightboxPrev: document.getElementById('lightbox-prev'),
    lightboxNext: document.getElementById('lightbox-next'),
    lightboxCounter: document.getElementById('lightbox-counter')
};

// 고유 ID 생성/조회 — 익명 인증 실패 시에만 쓰는 폴백 (로컬 스토리지 기반)
function getMyUserId() {
    try {
        let id = localStorage.getItem('sd_user_id');
        if (!id) {
            id = 'user_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
            localStorage.setItem('sd_user_id', id);
        }
        return id;
    } catch (e) {
        // 시크릿 모드 등으로 로컬스토리지 접근 불가 시 임시 ID
        return 'user_temp_' + Math.random().toString(36).substr(2, 9);
    }
}
// 사용자 식별: 익명 인증(uid) 우선.
// uid 기반이어야 Firestore Security Rules가 방장/업로더 소유권을 서버 측에서 강제할 수 있음 (SECURITY.md 참고)
const anonUid = await ensureAnonymousUser();
myUserId = anonUid || getMyUserId();

// 표시용 이름 (다른 사람 화면에 업로더 이름으로 노출)
function getMyUserName() {
    try {
        let name = localStorage.getItem('sd_user_name');
        if (!name) {
            name = '게스트' + Math.floor(1000 + Math.random() * 9000);
            localStorage.setItem('sd_user_name', name);
        }
        return name;
    } catch (e) {
        return '게스트';
    }
}
myUserName = getMyUserName();
els.inputUserName.value = myUserName;
els.inputUserName.addEventListener('change', () => {
    const name = els.inputUserName.value.trim();
    if (name) {
        myUserName = name;
        try {
            localStorage.setItem('sd_user_name', name);
            localStorage.setItem('sd_name_confirmed', '1'); // 직접 입력했으면 입장 시 재질문 안 함
        } catch (e) {}
    }
});

// 토스트 알림
function showToast(message, isError = false) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `fixed top-4 left-1/2 transform -translate-x-1/2 px-4 py-2 rounded-lg shadow-lg font-medium text-sm z-50 transition-all duration-300 ${isError ? 'bg-red-500 text-white' : 'bg-slate-800 text-white'}`;

    // 나타나기 애니메이션
    toast.style.opacity = '1';
    toast.style.transform = 'translate(-50%, 0)';

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translate(-50%, -1rem)';
    }, 3000);
}

// 모달창 띄우기
function showConfirmModal(title, desc, onConfirm) {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-desc').textContent = desc;
    modal.classList.remove('hidden');

    const btnCancel = document.getElementById('modal-cancel');
    const btnConfirm = document.getElementById('modal-confirm');

    const cleanup = () => {
        modal.classList.add('hidden');
        btnCancel.removeEventListener('click', handleCancel);
        btnConfirm.removeEventListener('click', handleConfirm);
    };

    const handleCancel = () => cleanup();
    const handleConfirm = () => {
        cleanup();
        onConfirm();
    };

    btnCancel.addEventListener('click', handleCancel);
    btnConfirm.addEventListener('click', handleConfirm);
}

function switchView(viewName) {
    if (viewName === 'home') {
        els.viewHome.classList.remove('hidden');
        els.viewRoom.classList.add('hidden');
    } else if (viewName === 'room') {
        els.viewHome.classList.add('hidden');
        els.viewRoom.classList.remove('hidden');
        els.emptyState.style.display = 'flex';
        els.galleryGrid.innerHTML = ''; // 초기화
        els.galleryGrid.appendChild(els.emptyState);
    }
}

// 해시 라우터 로직 (뒤로가기 완벽 지원)
async function handleRoute() {
    const hash = window.location.hash.replace('#', '');
    if (hash) {
        // 방 입장 시도
        await joinRoom(hash);
    } else {
        // 홈으로
        leaveRoom();
    }
}

// 브라우저 뒤로가기/앞으로가기 감지
window.addEventListener('hashchange', handleRoute);
window.addEventListener('popstate', () => {
    // hashchange가 잡지 못하는 경우를 대비한 2차 방어
    if(!window.location.hash) leaveRoom();
});

// 앱 내 홈버튼
els.btnGoHome.addEventListener('click', () => {
    window.location.hash = ''; // 해시를 지우면 자동으로 handleRoute가 작동하여 홈으로 감
});

els.btnCreateRoom.addEventListener('click', async () => {
    try {
        els.btnCreateRoom.disabled = true;
        els.btnCreateRoom.innerHTML = '<div class="loader mr-2"></div> 생성 중...';

        const roomName = els.inputRoomName.value.trim() || '새로운 공유룸';
        const expiryHours = parseInt(els.selectExpiry.value);
        const permission = els.selectPermission.value;
        const password = els.inputRoomPassword.value;
        const roomId = generateRoomCode();

        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + expiryHours);

        // Firestore에 방 문서 생성
        await setDoc(doc(db, "rooms", roomId), {
            name: roomName,
            createdAt: serverTimestamp(),
            expiresAt: expiresAt,
            ownerId: myUserId,
            ownerName: myUserName,
            permission: permission,
            passwordHash: password ? await sha256(roomId + ':' + password) : null, // roomId를 salt로 사용
            folders: [],
            status: 'active'
        });

        try { localStorage.setItem('sd_name_confirmed', '1'); } catch (e) {}
        showToast('방이 생성되었습니다!');
        // 생성 후 방으로 라우팅
        window.location.hash = roomId;
        els.inputRoomName.value = '';
        els.inputRoomPassword.value = '';

    } catch (error) {
        console.error("Error creating room: ", error);
        showToast('방 생성에 실패했습니다. DB 설정을 확인하세요.', true);
    } finally {
        els.btnCreateRoom.disabled = false;
        els.btnCreateRoom.innerHTML = '<span>Get Started Now</span><span class="w-7 h-7 rounded-full bg-white/90 text-[rgba(0,132,255,1)] flex items-center justify-center"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M14 5l7 7m0 0l-7 7m7-7H3"/></svg></span>';
    }
});

// 코드 입력 입장
els.btnJoinRoom.addEventListener('click', () => {
    const code = els.inputJoinCode.value.trim().toUpperCase();
    if (code) {
        window.location.hash = code;
        els.inputJoinCode.value = '';
    }
});

// 입장 암호 모달 (Promise 기반: 입력값 또는 취소 시 null 반환)
function askPassword() {
    return new Promise((resolve) => {
        els.passwordModal.classList.remove('hidden');
        els.passwordModal.classList.add('flex');
        els.passwordInput.value = '';
        setTimeout(() => els.passwordInput.focus(), 50);

        const cleanup = () => {
            els.passwordModal.classList.add('hidden');
            els.passwordModal.classList.remove('flex');
            els.passwordConfirm.removeEventListener('click', onOk);
            els.passwordCancel.removeEventListener('click', onCancel);
            els.passwordInput.removeEventListener('keydown', onKey);
        };
        const onOk = () => { const v = els.passwordInput.value; cleanup(); resolve(v); };
        const onCancel = () => { cleanup(); resolve(null); };
        const onKey = (e) => { if (e.key === 'Enter') onOk(); };

        els.passwordConfirm.addEventListener('click', onOk);
        els.passwordCancel.addEventListener('click', onCancel);
        els.passwordInput.addEventListener('keydown', onKey);
    });
}

// 닉네임을 한 번도 직접 정하지 않았으면 입장 시 물어봄
function maybeAskNickname() {
    let confirmed = false;
    try { confirmed = !!localStorage.getItem('sd_name_confirmed'); } catch (e) { confirmed = true; }
    if (confirmed) return;
    els.nicknameInput.value = myUserName;
    els.nicknameModal.classList.remove('hidden');
    els.nicknameModal.classList.add('flex');
    setTimeout(() => { els.nicknameInput.focus(); els.nicknameInput.select(); }, 50);
}
function confirmNickname() {
    const name = els.nicknameInput.value.trim();
    if (name) {
        myUserName = name;
        els.inputUserName.value = name;
        try {
            localStorage.setItem('sd_user_name', name);
            localStorage.setItem('sd_name_confirmed', '1');
        } catch (e) {}
    }
    els.nicknameModal.classList.add('hidden');
    els.nicknameModal.classList.remove('flex');
}
els.nicknameConfirm.addEventListener('click', confirmNickname);
els.nicknameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmNickname(); });

// 방 입장 및 구독 로직
async function joinRoom(roomId) {
    try {
        // 방 존재 여부 단발성 확인
        const roomSnap = await getDoc(doc(db, "rooms", roomId));
        if (!roomSnap.exists()) {
            showToast('존재하지 않거나 만료된 방입니다.', true);
            window.location.hash = ''; // 홈으로 리다이렉트
            return;
        }

        // 만료 여부 확인
        const roomData = roomSnap.data();
        const expires = roomData.expiresAt?.toDate ? roomData.expiresAt.toDate() : new Date(roomData.expiresAt);
        if (expires && expires < new Date()) {
            showToast('만료된 방입니다.', true);
            window.location.hash = '';
            return;
        }

        // 입장 암호 확인 (방장은 통과, 같은 세션에서는 재입력 불필요)
        if (roomData.passwordHash && roomData.ownerId !== myUserId) {
            let unlocked = false;
            try { unlocked = sessionStorage.getItem('sd_pw_' + roomId) === roomData.passwordHash; } catch (e) {}
            if (!unlocked) {
                const entered = await askPassword();
                if (entered === null) { window.location.hash = ''; return; } // 취소 → 홈
                const hash = await sha256(roomId + ':' + entered);
                if (hash !== roomData.passwordHash) {
                    showToast('암호가 일치하지 않습니다.', true);
                    window.location.hash = '';
                    return;
                }
                try { sessionStorage.setItem('sd_pw_' + roomId, hash); } catch (e) {}
            }
        }

        currentRoomId = roomId;
        switchView('room');
        maybeAskNickname(); // 링크/코드 입장 시 최초 1회 닉네임 확인

        // 기존 구독 해제
        if (unsubscribeRoom) unsubscribeRoom();
        if (unsubscribeImages) unsubscribeImages();

        selectedImageIds.clear();
        currentFolder = null;
        lastSelectedIndex = null;
        renderLimit = RENDER_CHUNK;
        updateSelectionUI();

        // 1. 방 메타데이터 실시간 구독
        unsubscribeRoom = onSnapshot(doc(db, "rooms", roomId), (docSnap) => {
            if (docSnap.exists()) {
                const data = docSnap.data();
                currentRoomData = data;
                updateRoomUI(roomId, data);
            } else {
                // 방이 삭제되었을 때
                showToast('방장이 방을 삭제하여 종료되었습니다.', true);
                window.location.hash = '';
            }
        });

        // 2. 이미지 컬렉션 실시간 구독
        const imagesRef = collection(db, "rooms", roomId, "images");
        const q = query(imagesRef, orderBy("uploadedAt", "desc"));

        unsubscribeImages = onSnapshot(q, (querySnapshot) => {
            imagesData = [];
            querySnapshot.forEach((doc) => {
                imagesData.push({ id: doc.id, ...doc.data() });
            });
            updateUploaderFilterOptions();
            renderFolderChips(); // 폴더별 개수 갱신
            renderGallery();
        });

    } catch (error) {
        console.error("Join room error:", error);
        showToast('방 입장 중 오류가 발생했습니다.', true);
        window.location.hash = '';
    }
}

function leaveRoom() {
    if (unsubscribeRoom) unsubscribeRoom();
    if (unsubscribeImages) unsubscribeImages();
    currentRoomId = null;
    currentRoomData = null;
    imagesData = [];
    selectedImageIds.clear();
    currentFolder = null;
    switchView('home');
}

// 방 UI 업데이트 (권한, 시간, 이름)
function updateRoomUI(roomId, data) {
    els.uiRoomName.textContent = data.name;
    els.uiRoomCode.textContent = roomId;

    // 방장 권한 체크 및 UI 반영
    const isOwner = (data.ownerId === myUserId);
    if (isOwner) {
        els.uiOwnerBadge.classList.remove('hidden');
        els.btnDeleteRoom.classList.remove('hidden');
        els.btnDeleteRoom.classList.add('flex');
        els.btnRoomSettings.classList.remove('hidden');
        els.btnRoomSettings.classList.add('flex');
    } else {
        els.uiOwnerBadge.classList.add('hidden');
        els.btnDeleteRoom.classList.add('hidden');
        els.btnDeleteRoom.classList.remove('flex');
        els.btnRoomSettings.classList.add('hidden');
        els.btnRoomSettings.classList.remove('flex');
    }

    // 업로드 권한 체크
    if (data.permission === 'owner' && !isOwner) {
        els.btnUploadWrapper.style.display = 'none'; // 비방장 업로드 숨김
    } else {
        els.btnUploadWrapper.style.display = 'block';
    }

    // 폴더 칩 갱신
    renderFolderChips();

    // 남은 시간 계산 타이머
    updateCountdown(data.expiresAt);
    if(!window.countdownTimer) {
        window.countdownTimer = setInterval(() => {
            if(currentRoomData) updateCountdown(currentRoomData.expiresAt);
        }, 60000); // 1분마다
    }
}

function updateCountdown(timestampStr) {
    if(!timestampStr) return;
    // Firestore Timestamp or JS Date handling
    let expires = typeof timestampStr.toDate === 'function' ? timestampStr.toDate() : new Date(timestampStr);
    const now = new Date();
    const diff = expires - now;

    if (diff <= 0) {
        els.uiCountdown.textContent = '만료됨';
        els.uiCountdown.classList.add('text-red-500');
    } else {
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const days = Math.floor(hours / 24);
        els.uiCountdown.textContent = days > 0
            ? `${days}일 ${hours % 24}시간 남음`
            : `${hours}시간 ${mins}분 남음`;
        els.uiCountdown.classList.remove('text-red-500');
    }
}

// ===== 폴더 =====
function renderFolderChips() {
    const folders = currentRoomData?.folders || [];
    // 보고 있던 폴더가 사라졌으면 전체로
    if (currentFolder && !folders.includes(currentFolder)) currentFolder = null;

    // 폴더별 파일 개수
    const folderCounts = {};
    imagesData.forEach(img => {
        if (img.folder) folderCounts[img.folder] = (folderCounts[img.folder] || 0) + 1;
    });

    const base = 'folder-chip chip-glass shrink-0 px-3 py-1.5 rounded-full text-xs font-medium';
    let html = `<button data-folder="" class="${base} ${!currentFolder ? 'chip-active' : 'text-slate-600'}">전체 (${imagesData.length})</button>`;
    folders.forEach(f => {
        const active = currentFolder === f;
        html += `<button data-folder="${escapeHtml(f)}" class="${base} ${active ? 'chip-active' : 'text-slate-600'}">📁 ${escapeHtml(f)} (${folderCounts[f] || 0})</button>`;
    });
    els.folderChips.innerHTML = html;

    // '폴더로 이동' 셀렉트 옵션 갱신
    let moveHtml = `<option value="">폴더로 이동...</option>`;
    folders.forEach(f => { moveHtml += `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`; });
    moveHtml += `<option value="__new__">+ 새 폴더 만들어 이동</option>`;
    moveHtml += `<option value="__root__">폴더에서 꺼내기</option>`;
    els.moveFolder.innerHTML = moveHtml;
}

// 폴더 칩 클릭 → 해당 폴더만 보기
els.folderChips.addEventListener('click', (e) => {
    const chip = e.target.closest('.folder-chip');
    if (!chip) return;
    currentFolder = chip.dataset.folder || null;
    renderLimit = RENDER_CHUNK;
    renderFolderChips();
    renderGallery();
});

// '+ 새 폴더' 버튼 → 인라인 이름 입력창으로 전환
els.btnNewFolder.addEventListener('click', () => {
    els.btnNewFolder.classList.add('hidden');
    els.inputNewFolder.classList.remove('hidden');
    els.inputNewFolder.value = '';
    els.inputNewFolder.focus();
});

async function commitNewFolder() {
    const name = els.inputNewFolder.value.trim();
    els.inputNewFolder.value = ''; // blur/Enter 중복 실행 방지
    els.inputNewFolder.classList.add('hidden');
    els.btnNewFolder.classList.remove('hidden');
    if (!name || !currentRoomId) { pendingMoveIds = null; return; }

    const folders = currentRoomData?.folders || [];
    currentFolder = name; // 생성 즉시 해당 폴더로 이동
    try {
        if (!folders.includes(name)) {
            await updateDoc(doc(db, "rooms", currentRoomId), { folders: arrayUnion(name) });
            showToast(`'${name}' 폴더가 생성되었습니다.`);
        }
        // '+ 새 폴더 만들어 이동'으로 열렸다면 선택 항목을 새 폴더로 이동
        if (pendingMoveIds && pendingMoveIds.length > 0) {
            const ids = pendingMoveIds;
            pendingMoveIds = null;
            await Promise.all(ids.map(id =>
                updateDoc(doc(db, "rooms", currentRoomId, "images", id), { folder: name })
            ));
            selectedImageIds.clear();
            updateSelectionUI();
            showToast(`${ids.length}개를 '${name}' 폴더로 이동했습니다.`);
        }
        renderFolderChips();
        renderGallery();
    } catch (err) {
        console.error('Create folder error:', err);
        pendingMoveIds = null;
        showToast('폴더 생성에 실패했습니다.', true);
    }
}
els.inputNewFolder.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitNewFolder(); }
    if (e.key === 'Escape') {
        els.inputNewFolder.value = '';
        els.inputNewFolder.classList.add('hidden');
        els.btnNewFolder.classList.remove('hidden');
        pendingMoveIds = null;
    }
});
els.inputNewFolder.addEventListener('blur', commitNewFolder);

// 선택한 파일들을 폴더로 이동
els.moveFolder.addEventListener('change', async () => {
    const val = els.moveFolder.value;
    els.moveFolder.value = '';
    if (!val || selectedImageIds.size === 0 || !currentRoomId) return;

    // '+ 새 폴더 만들어 이동' → 이름 입력창을 열고, 생성 완료 시 이동
    if (val === '__new__') {
        pendingMoveIds = [...selectedImageIds];
        els.btnNewFolder.click();
        showToast('폴더 이름을 입력하면 선택한 파일이 그 폴더로 이동합니다.');
        return;
    }

    const target = val === '__root__' ? null : val;
    try {
        const updates = [...selectedImageIds].map(id =>
            updateDoc(doc(db, "rooms", currentRoomId, "images", id), { folder: target })
        );
        await Promise.all(updates);
        showToast(target ? `${updates.length}개를 '${target}' 폴더로 이동했습니다.` : `${updates.length}개를 폴더에서 꺼냈습니다.`);
        selectedImageIds.clear();
        updateSelectionUI();
    } catch (err) {
        console.error('Move to folder error:', err);
        showToast('폴더 이동에 실패했습니다.', true);
    }
});

// ===== 방 설정 변경 (방장 전용) =====
els.btnRoomSettings.addEventListener('click', () => {
    if (!currentRoomData) return;
    els.settingsName.value = currentRoomData.name || '';
    els.settingsExpiry.value = 'keep';
    els.settingsPermission.value = currentRoomData.permission || 'all';
    els.settingsPassword.value = '';
    els.settingsPassword.placeholder = currentRoomData.passwordHash ? '암호 설정됨 · 변경하려면 입력' : '새 암호 입력 (설정 시에만)';
    els.settingsRemovePassword.checked = false;
    els.settingsModal.classList.remove('hidden');
    els.settingsModal.classList.add('flex');
});

function closeSettingsModal() {
    els.settingsModal.classList.add('hidden');
    els.settingsModal.classList.remove('flex');
}
els.settingsCancel.addEventListener('click', closeSettingsModal);

els.settingsSave.addEventListener('click', async () => {
    if (!currentRoomId) return;
    try {
        const updates = {
            name: els.settingsName.value.trim() || '새로운 공유룸',
            permission: els.settingsPermission.value
        };
        if (els.settingsExpiry.value !== 'keep') {
            const expiresAt = new Date();
            expiresAt.setHours(expiresAt.getHours() + parseInt(els.settingsExpiry.value));
            updates.expiresAt = expiresAt;
        }
        // 입장 암호: 해제 체크 > 새 암호 입력 > 유지
        if (els.settingsRemovePassword.checked) {
            updates.passwordHash = null;
        } else if (els.settingsPassword.value) {
            updates.passwordHash = await sha256(currentRoomId + ':' + els.settingsPassword.value);
        }
        await updateDoc(doc(db, "rooms", currentRoomId), updates);
        closeSettingsModal();
        showToast('방 설정이 변경되었습니다.');
    } catch (err) {
        console.error('Settings update error:', err);
        showToast('설정 변경에 실패했습니다.', true);
    }
});

els.btnDeleteRoom.addEventListener('click', () => {
    showConfirmModal(
        '방 삭제하기',
        '이 방과 업로드된 모든 이미지 데이터가 영구적으로 삭제됩니다. 계속하시겠습니까?',
        async () => {
            if(!currentRoomId) return;
            try {
                const rId = currentRoomId; // 로컬 변수 백업
                showToast('데이터를 삭제하는 중입니다...');

                // 1. 방 안의 모든 이미지 데이터 일괄 삭제
                const imagesRef = collection(db, "rooms", rId, "images");
                const querySnapshot = await getDocs(imagesRef);

                const deletePromises = [];
                querySnapshot.forEach((docSnap) => {
                    deletePromises.push(deleteDoc(docSnap.ref));
                });
                await Promise.all(deletePromises); // 병렬 삭제 대기

                // 2. 방 문서 삭제
                await deleteDoc(doc(db, "rooms", rId));

                // 방이 삭제되면 onSnapshot에서 알아서 홈으로 보냄
                showToast('방이 성공적으로 삭제되었습니다.');
            } catch (err) {
                console.error('Delete room error:', err);
                showToast('삭제 중 오류가 발생했습니다.', true);
            }
        }
    );
});

els.uiRoomCode.addEventListener('click', () => {
    navigator.clipboard.writeText(currentRoomId)
        .then(() => showToast('방 코드가 복사되었습니다.'))
        .catch(() => fallbackCopy(currentRoomId));
});

els.btnCopyLink.addEventListener('click', () => {
    // 현재 호스트(사이트 주소) + 해시(#) 라우팅 링크 생성
    let link = window.location.origin + window.location.pathname + '#' + currentRoomId;

    // 샌드박스(미리보기) 환경 예외 처리 (blob 주소 방지)
    if(window.location.origin.includes('blob') || window.location.origin === 'null') {
         link = `https://나의-웹사이트.com/#${currentRoomId}`;
         showToast('미리보기 환경이라 예시 링크가 복사됩니다.');
    }

    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(link)
            .then(() => showToast('초대 링크가 복사되었습니다!'))
            .catch(() => fallbackCopy(link));
    } else {
        fallbackCopy(link);
    }
});

function fallbackCopy(text) {
    try {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.style.position = "fixed";  // 화면 밖으로
        textArea.style.left = "-9999px";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);

        if(successful) showToast('복사되었습니다!');
        else showToast('복사에 실패했습니다.', true);
    } catch (err) {
        showToast('브라우저가 복사를 지원하지 않습니다.', true);
    }
}

// ===== 업로드 (진행 상태 + 실패 재시도) =====
async function handleUpload(files) {
    if (!currentRoomId || files.length === 0) return;

    // 드래그 앤 드롭 경로도 권한 체크
    if (currentRoomData?.permission === 'owner' && currentRoomData.ownerId !== myUserId) {
        showToast('이 방은 방장만 업로드할 수 있습니다.', true);
        return;
    }

    const validFiles = Array.from(files).filter(f => f.type.startsWith('image/') || f.type.startsWith('video/'));
    if (validFiles.length === 0) {
        showToast('이미지/비디오 파일만 업로드 가능합니다.', true);
        return;
    }

    for (const file of validFiles) {
        const id = 'task_' + (++uploadTaskSeq);
        uploadTasks.set(id, { id, file, status: 'waiting' });
    }
    renderUploadPanel();
    runUploadQueue();
}

// 대기 중인 작업을 순차 처리 (중복 실행 방지)
async function runUploadQueue() {
    if (uploadQueueRunning) return;
    uploadQueueRunning = true;
    try {
        let next;
        while ((next = [...uploadTasks.values()].find(t => t.status === 'waiting'))) {
            await processUploadTask(next);
        }
    } finally {
        uploadQueueRunning = false;
    }
    // 전부 성공했으면 잠시 후 패널 자동 닫기
    const tasks = [...uploadTasks.values()];
    if (tasks.length > 0 && tasks.every(t => t.status === 'done')) {
        showToast(`${tasks.length}개 이미지 업로드 완료!`);
        setTimeout(() => {
            if ([...uploadTasks.values()].every(t => t.status === 'done')) {
                uploadTasks.clear();
                renderUploadPanel();
            }
        }, 2000);
    }
}

async function processUploadTask(task) {
    task.status = 'uploading';
    renderUploadPanel();
    try {
        const file = task.file;
        const isVideo = file.type.startsWith('video/');
        const format = getFormatFromMime(file.type);
        let base64Data = '';

        if (isVideo) {
            // 비디오는 압축 없이 원본 저장 (Firestore 문서 제한 때문에 크기 체크 선행)
            if (file.size > 700 * 1024) {
                throw new Error('비디오는 700KB 이하만 가능 (데모 제한)');
            }
            base64Data = await readAsDataURL(file);
        } else if (format === 'gif' || file.size < 500 * 1024) {
            // GIF는 압축 없이 원본 유지 (애니메이션 보존)
            base64Data = await readAsDataURL(file);
        } else {
            base64Data = await compressImage(file, 1600, 0.8); // 최대 해상도 1600px
        }

        // Firestore 문서 크기 제한(1MB) 대비: 너무 크면 한 단계 더 압축
        if (base64Data.length > 900 * 1024 && format !== 'gif' && !isVideo) {
            base64Data = await compressImage(file, 1200, 0.7);
        }
        if (base64Data.length > 980 * 1024) {
            throw new Error('파일이 너무 큽니다 (1MB 제한)');
        }

        // Firestore에 저장 (Base64 방식 - 데모용. 실제론 Storage 권장)
        await addDoc(collection(db, "rooms", currentRoomId, "images"), {
            dataUrl: base64Data,
            uploaderId: myUserId,
            uploaderName: myUserName,
            uploadedAt: serverTimestamp(),
            fileName: file.name,
            format: format,
            kind: isVideo ? 'video' : 'image',
            folder: currentFolder,
            size: file.size,
            // Firestore TTL 정책용 만료 시각 복제 (방 만료 시 이미지 문서도 자동 삭제 가능)
            expiresAt: currentRoomData?.expiresAt || null
        });
        task.status = 'done';
    } catch (error) {
        console.error("Upload error:", error);
        task.status = 'error';
        task.errorMsg = error?.message || '업로드 실패';
    }
    renderUploadPanel();
}

// 업로드 진행 상태 패널 렌더링
function renderUploadPanel() {
    const tasks = [...uploadTasks.values()];
    if (tasks.length === 0) {
        els.uploadPanel.classList.add('hidden');
        return;
    }
    els.uploadPanel.classList.remove('hidden');

    const doneCount = tasks.filter(t => t.status === 'done').length;
    const errorCount = tasks.filter(t => t.status === 'error').length;
    const finished = doneCount + errorCount === tasks.length;

    els.uploadPanelTitle.textContent = finished
        ? (errorCount > 0 ? `업로드 완료 (실패 ${errorCount}개)` : '업로드 완료')
        : `업로드 중... (${doneCount}/${tasks.length})`;
    els.uploadProgressBar.style.width = `${Math.round((doneCount / tasks.length) * 100)}%`;
    els.uploadProgressBar.className = `h-full transition-all duration-300 ${errorCount > 0 && finished ? 'bg-red-500' : 'bg-blue-500'}`;

    els.uploadList.innerHTML = tasks.map(t => {
        let statusHtml = '';
        if (t.status === 'waiting') {
            statusHtml = `<span class="text-[11px] text-slate-400">대기 중</span>`;
        } else if (t.status === 'uploading') {
            statusHtml = `<div class="loader" style="width:14px;height:14px;border-width:2px;"></div>`;
        } else if (t.status === 'done') {
            statusHtml = `<svg class="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>`;
        } else {
            statusHtml = `<button class="btn-retry-upload text-[11px] font-bold text-red-600 hover:text-red-700 bg-red-50 hover:bg-red-100 px-2 py-0.5 rounded" data-task-id="${t.id}">재시도</button>`;
        }
        return `
            <div class="flex items-center justify-between gap-2 px-4 py-2">
                <div class="flex-1 min-w-0">
                    <p class="text-xs font-medium text-slate-700 truncate">${escapeHtml(t.file.name)}</p>
                    ${t.status === 'error' ? `<p class="text-[10px] text-red-500 truncate">${escapeHtml(t.errorMsg || '업로드 실패')}</p>` : ''}
                </div>
                <div class="shrink-0 flex items-center">${statusHtml}</div>
            </div>
        `;
    }).join('');
}

// 재시도 버튼 (이벤트 위임)
els.uploadList.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-retry-upload');
    if (!btn) return;
    const task = uploadTasks.get(btn.dataset.taskId);
    if (task && task.status === 'error') {
        task.status = 'waiting';
        delete task.errorMsg;
        renderUploadPanel();
        runUploadQueue();
    }
});

els.uploadPanelClose.addEventListener('click', () => {
    // 진행 중이 아닌 작업만 정리하고 닫기
    const uploading = [...uploadTasks.values()].some(t => t.status === 'uploading' || t.status === 'waiting');
    if (uploading) {
        showToast('아직 업로드가 진행 중입니다.', true);
        return;
    }
    uploadTasks.clear();
    renderUploadPanel();
});

// 드래그 앤 드롭 이벤트 바인딩
els.inputFile.addEventListener('change', (e) => {
    handleUpload(e.target.files);
    e.target.value = ''; // 동일 파일 재업로드를 위해 초기화
});
window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if(currentRoomId) els.dragOverlay.classList.remove('hidden');
});
window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (e.relatedTarget === null) els.dragOverlay.classList.add('hidden');
});
window.addEventListener('drop', (e) => {
    e.preventDefault();
    els.dragOverlay.classList.add('hidden');
    if(currentRoomId) handleUpload(e.dataTransfer.files);
});

// 올린 사람 별 필터 옵션 동적 구성 (대규모 방 대비: 업로드 수 내림차순 + 개수 표시)
function updateUploaderFilterOptions() {
    const sel = els.filterUploader;
    const current = sel.value;

    const uploaders = new Map(); // uploaderId -> { name, count }
    imagesData.forEach(img => {
        if (img.uploaderId && img.uploaderId !== myUserId) {
            const u = uploaders.get(img.uploaderId) || { name: img.uploaderName || '익명', count: 0 };
            u.count++;
            uploaders.set(img.uploaderId, u);
        }
    });

    let html = `
        <option value="all">모든 사용자 사진</option>
        <option value="mine">내가 올린 사진만</option>
        <option value="others">다른 사람이 올린 사진</option>
    `;
    [...uploaders.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .forEach(([id, u]) => {
            html += `<option value="user:${escapeHtml(id)}">${escapeHtml(u.name)} (${u.count})</option>`;
        });
    sel.innerHTML = html;

    // 기존 선택 값 유지 (해당 업로더가 사라졌으면 전체로)
    sel.value = [...sel.options].some(o => o.value === current) ? current : 'all';
}

function renderGallery() {
    // 필터 값 가져오기
    const uploaderFilter = els.filterUploader.value;
    const formatFilter = els.filterFormat.value;

    // 조건에 맞게 데이터 필터링
    let filteredImages = imagesData.filter(img => {
        // 1. 업로더 필터
        let uploaderMatch = true;
        if (uploaderFilter === 'mine') uploaderMatch = (img.uploaderId === myUserId);
        else if (uploaderFilter === 'others') uploaderMatch = (img.uploaderId !== myUserId);
        else if (uploaderFilter.startsWith('user:')) uploaderMatch = (img.uploaderId === uploaderFilter.slice(5));

        // 2. 포맷 필터 ('비디오'는 종류로 판별)
        let formatMatch = true;
        if (formatFilter === 'video') formatMatch = (img.kind === 'video');
        else if (formatFilter !== 'all') formatMatch = (img.format === formatFilter);

        // 3. 폴더 필터 (전체 탭은 모든 파일 표시)
        const folderMatch = !currentFolder || (img.folder === currentFolder);

        return uploaderMatch && formatMatch && folderMatch;
    });

    currentFilteredImages = filteredImages;

    // 화면 초기화
    els.galleryGrid.innerHTML = '';

    if (filteredImages.length === 0) {
        els.emptyState.style.display = 'flex';
        els.galleryGrid.appendChild(els.emptyState);
        els.loadMoreWrap.classList.add('hidden');
        return;
    }

    els.emptyState.style.display = 'none';

    // 대규모 방 대비: renderLimit개까지만 렌더링, 나머지는 '더 보기'
    const remaining = filteredImages.length - renderLimit;
    if (remaining > 0) {
        els.loadMoreWrap.classList.remove('hidden');
        els.loadMoreCount.textContent = remaining;
    } else {
        els.loadMoreWrap.classList.add('hidden');
    }

    // 이미지 카드 렌더링
    filteredImages.slice(0, renderLimit).forEach((img, idx) => {
        const isMine = img.uploaderId === myUserId;
        const isChecked = selectedImageIds.has(img.id);
        const formatBadgeClass = getFormatBadgeColor(img.format);
        const uploaderLabel = isMine ? '내가 올림' : escapeHtml(img.uploaderName || '익명');
        const isVideoItem = img.kind === 'video';
        const canDelete = isMine || (currentRoomData?.ownerId === myUserId); // 본인 업로드 또는 방장

        // 비디오는 <video> + 재생 아이콘, 이미지는 <img>
        const mediaHtml = isVideoItem
            ? `<video src="${img.dataUrl}" class="w-full h-full object-cover" preload="metadata" muted playsinline></video>
               <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
                   <div class="w-10 h-10 bg-black/50 rounded-full flex items-center justify-center backdrop-blur-sm">
                       <svg class="w-5 h-5 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                   </div>
               </div>`
            : `<img src="${img.dataUrl}" class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105" loading="lazy">`;

        const card = document.createElement('div');
        card.className = "sd-card relative group rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-all border border-slate-200 bg-white fade-in h-full flex flex-col";
        card.dataset.imgId = img.id;
        card.innerHTML = `
            <!-- 체크박스 (숨김) -->
            <input type="checkbox" id="chk-${img.id}" class="image-checkbox" ${isChecked ? 'checked' : ''}>

            <!-- 이미지 라벨(클릭 영역) -->
            <label for="chk-${img.id}" class="relative w-full h-full cursor-pointer flex-1 block overflow-hidden bg-slate-100">
                ${mediaHtml}

                <!-- 체크 오버레이 -->
                <div class="check-overlay absolute inset-0 bg-blue-500/10 opacity-0 transition-opacity rounded-xl box-border"></div>

                <!-- 체크 아이콘 -->
                <div class="check-icon absolute top-2 left-2 w-6 h-6 bg-blue-500 rounded-full text-white flex items-center justify-center scale-0 opacity-0 transition-all shadow-sm">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg>
                </div>

                <!-- 뱃지 영역 -->
                <div class="absolute bottom-2 left-2 flex gap-1 pointer-events-none">
                    <span class="px-1.5 py-0.5 ${isMine ? 'bg-blue-600/90' : 'bg-slate-900/70'} text-white text-[10px] font-bold rounded backdrop-blur-sm shadow-sm">${uploaderLabel}</span>
                    <span class="px-1.5 py-0.5 ${formatBadgeClass} text-[10px] font-bold rounded uppercase shadow-sm">${img.format || 'IMG'}</span>
                </div>
            </label>

            <!-- 크게 보기 & 개별 다운로드 & 삭제 버튼 (데스크톱: 호버 시, 모바일: 항상 표시) -->
            <div class="card-actions absolute top-2 right-2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button class="btn-enlarge bg-white/90 hover:bg-white text-slate-700 p-1.5 rounded-lg shadow-sm transition-colors" data-id="${img.id}" title="크게 보기">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7"/></svg>
                </button>
                <button class="btn-single-dl bg-white/90 hover:bg-white text-slate-700 p-1.5 rounded-lg shadow-sm transition-colors" data-id="${img.id}" title="${canShareFiles ? '사진첩 저장' : '다운로드'}">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                </button>
                ${canDelete ? `
                <button class="btn-delete bg-white/90 hover:bg-red-50 text-red-500 p-1.5 rounded-lg shadow-sm transition-colors" data-id="${img.id}" title="삭제">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                </button>` : ''}
            </div>
        `;

        els.galleryGrid.appendChild(card);

        // Shift+클릭: 마지막 선택 항목부터 범위 선택
        card.querySelector('label').addEventListener('click', (e) => {
            if (e.shiftKey && lastSelectedIndex !== null && lastSelectedIndex !== idx) {
                e.preventDefault();
                const [from, to] = [Math.min(lastSelectedIndex, idx), Math.max(lastSelectedIndex, idx)];
                for (let i = from; i <= to; i++) selectedImageIds.add(currentFilteredImages[i].id);
                lastSelectedIndex = idx;
                syncCheckboxes();
                updateSelectionUI();
            }
        });

        // 체크박스 상태 연동
        const chk = card.querySelector(`#chk-${img.id}`);
        chk.addEventListener('change', (e) => {
            if (e.target.checked) selectedImageIds.add(img.id);
            else selectedImageIds.delete(img.id);
            lastSelectedIndex = idx;
            updateSelectionUI();
        });

        // 개별 다운로드 이벤트
        card.querySelector('.btn-single-dl').addEventListener('click', (e) => {
            e.stopPropagation(); // 라벨 클릭 방지
            downloadSingleImage(img);
        });

        // 크게 보기 이벤트
        card.querySelector('.btn-enlarge').addEventListener('click', (e) => {
            e.stopPropagation();
            openLightbox(img);
        });

        // 삭제 이벤트 (본인 업로드 또는 방장만 버튼 존재)
        const delBtn = card.querySelector('.btn-delete');
        if (delBtn) {
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                showConfirmModal('파일 삭제', `'${img.fileName || '이 파일'}'을(를) 삭제할까요? 되돌릴 수 없습니다.`, async () => {
                    try {
                        await deleteDoc(doc(db, "rooms", currentRoomId, "images", img.id));
                        selectedImageIds.delete(img.id);
                        updateSelectionUI();
                        showToast('삭제되었습니다.');
                    } catch (err) {
                        console.error('Delete image error:', err);
                        showToast('삭제에 실패했습니다.', true);
                    }
                });
            });
        }
    });
}

// 화면에 렌더된 체크박스를 선택 상태와 동기화
function syncCheckboxes() {
    document.querySelectorAll('#gallery-grid .sd-card').forEach(card => {
        card.querySelector('.image-checkbox').checked = selectedImageIds.has(card.dataset.imgId);
    });
}

// '더 보기' — 다음 청크 렌더링
els.btnLoadMore.addEventListener('click', () => {
    renderLimit += RENDER_CHUNK;
    renderGallery();
});

// 필터 변경 시 리렌더링 (점진 렌더링 카운터 초기화)
function onFilterChange() {
    renderLimit = RENDER_CHUNK;
    renderGallery();
}
els.filterUploader.addEventListener('change', onFilterChange);
els.filterFormat.addEventListener('change', onFilterChange);

// 라이트박스에서 보고 있는 항목의 위치 (currentFilteredImages 기준)
let lightboxIndex = -1;

function openLightbox(imgObj) {
    const idx = currentFilteredImages.findIndex(i => i.id === imgObj.id);
    renderLightboxAt(idx === -1 ? 0 : idx, imgObj);

    els.lightbox.classList.remove('hidden');
    els.lightbox.classList.add('flex');
    document.body.style.overflow = 'hidden'; // 뒤 배경 스크롤 방지
}

// ← → 로 이동
function stepLightbox(delta) {
    const next = lightboxIndex + delta;
    if (next < 0 || next >= currentFilteredImages.length) return; // 양 끝에서는 멈춤
    renderLightboxAt(next);
}

function renderLightboxAt(index, fallbackObj = null) {
    const imgObj = currentFilteredImages[index] || fallbackObj;
    if (!imgObj) return;
    lightboxIndex = index;

    // 위치 표시 + 양 끝에서 화살표 버튼 숨김
    const total = currentFilteredImages.length;
    els.lightboxCounter.textContent = total > 0 ? `${index + 1} / ${total}` : '';
    els.lightboxPrev.classList.toggle('invisible', index <= 0);
    els.lightboxNext.classList.toggle('invisible', index >= total - 1);

    if (imgObj.kind === 'video') {
        els.lightboxImg.classList.add('hidden');
        els.lightboxImg.src = '';
        els.lightboxVideo.classList.remove('hidden');
        els.lightboxVideo.src = imgObj.dataUrl;
        els.lightboxVideo.play().catch(() => {});
    } else {
        els.lightboxVideo.classList.add('hidden');
        els.lightboxVideo.pause();
        els.lightboxVideo.removeAttribute('src');
        els.lightboxImg.classList.remove('hidden');
        els.lightboxImg.src = imgObj.dataUrl;
    }

    const isMine = imgObj.uploaderId === myUserId;
    const dateStr = imgObj.uploadedAt?.toDate ? imgObj.uploadedAt.toDate().toLocaleString() : '방금 전';
    const uploaderLabel = isMine ? '내가 올림' : escapeHtml(imgObj.uploaderName || '익명');

    els.lightboxInfo.innerHTML = `
        <span class="${isMine ? 'text-blue-400' : 'text-gray-200'} font-bold mr-2">${uploaderLabel}</span>
        <span class="text-gray-300 text-xs">${dateStr}</span>
        <span class="uppercase ml-2 px-1.5 py-0.5 bg-gray-800 text-gray-300 rounded text-xs">${imgObj.format || 'IMG'}</span>
        ${imgObj.fileName ? `<span class="text-gray-400 text-xs ml-2">${escapeHtml(imgObj.fileName)}</span>` : ''}
    `;
}

function closeLightbox() {
    els.lightbox.classList.add('hidden');
    els.lightbox.classList.remove('flex');
    els.lightboxImg.src = '';
    els.lightboxVideo.pause();
    els.lightboxVideo.removeAttribute('src');
    document.body.style.overflow = '';
    lightboxIndex = -1;
}

function isLightboxOpen() {
    return !els.lightbox.classList.contains('hidden');
}

els.lightboxClose.addEventListener('click', closeLightbox);
els.lightbox.addEventListener('click', (e) => {
    if (e.target === els.lightbox) closeLightbox(); // 배경 클릭 시 닫기
});
els.lightboxPrev.addEventListener('click', (e) => { e.stopPropagation(); stepLightbox(-1); });
els.lightboxNext.addEventListener('click', (e) => { e.stopPropagation(); stepLightbox(1); });

// 키보드: ← → 로 사진 이동, ESC 로 닫기
document.addEventListener('keydown', (e) => {
    if (!isLightboxOpen()) return;
    if (e.key === 'Escape') {
        e.preventDefault();
        closeLightbox();
    } else if (e.key === 'ArrowLeft') {
        e.preventDefault();  // 영상 탐색(seek) 등 기본 동작 방지
        stepLightbox(-1);
    } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        stepLightbox(1);
    }
});

function updateSelectionUI() {
    const count = selectedImageIds.size;
    els.uiSelectedCount.textContent = `선택됨: ${count}개`;

    const hasSelection = count > 0;
    // 선택 액션 그룹은 선택된 항목이 있을 때만 노출 (모바일 상단 여백 절약)
    els.selectionActions.classList.toggle('hidden', !hasSelection);
    els.selectionActions.classList.toggle('flex', hasSelection);
    els.uiSelectedCount.classList.toggle('hidden', !hasSelection);
}

// 모바일(공유 시트 지원 기기)에서만 '사진첩 저장' 버튼 노출
if (canShareFiles) {
    els.btnSavePhotos.classList.remove('hidden');
    els.btnSavePhotos.classList.add('flex');
}

els.btnUnselectAll.addEventListener('click', () => {
    selectedImageIds.clear();
    document.querySelectorAll('.image-checkbox').forEach(chk => chk.checked = false);
    updateSelectionUI();
});

// 전체 선택 (현재 필터 기준, 이미 전체 선택이면 해제 토글)
els.btnSelectAll.addEventListener('click', () => {
    if (currentFilteredImages.length === 0) return;
    const allSelected = currentFilteredImages.every(img => selectedImageIds.has(img.id));
    if (allSelected) {
        currentFilteredImages.forEach(img => selectedImageIds.delete(img.id));
    } else {
        currentFilteredImages.forEach(img => selectedImageIds.add(img.id));
    }
    syncCheckboxes();
    updateSelectionUI();
});

// 선택 삭제 (본인 업로드 또는 방장 권한이 있는 항목만)
els.btnDeleteSelected.addEventListener('click', () => {
    if (selectedImageIds.size === 0) return;
    const isOwner = currentRoomData?.ownerId === myUserId;
    const deletable = imagesData.filter(img => selectedImageIds.has(img.id) && (isOwner || img.uploaderId === myUserId));
    const skipped = selectedImageIds.size - deletable.length;

    if (deletable.length === 0) {
        showToast('삭제 권한이 있는 파일이 없습니다. (본인 업로드 또는 방장만 가능)', true);
        return;
    }
    showConfirmModal(
        '선택 삭제',
        `${deletable.length}개 파일을 삭제합니다.${skipped > 0 ? ` (권한 없는 ${skipped}개는 제외)` : ''} 되돌릴 수 없습니다. 계속할까요?`,
        async () => {
            try {
                await Promise.all(deletable.map(img => deleteDoc(doc(db, "rooms", currentRoomId, "images", img.id))));
                selectedImageIds.clear();
                updateSelectionUI();
                showToast(`${deletable.length}개 파일이 삭제되었습니다.`);
            } catch (err) {
                console.error('Bulk delete error:', err);
                showToast('삭제 중 오류가 발생했습니다.', true);
            }
        }
    );
});

// 사진첩 저장 (모바일): 선택 파일들을 공유 시트로 → 갤러리/사진 앱 선택 시 사진첩에 저장
// ※ 안드로이드(갤럭시 등)는 다중 파일 공유를 거부하는 경우가 있어 단계적으로 폴백한다.
els.btnSavePhotos.addEventListener('click', async () => {
    if (selectedImageIds.size === 0) return;

    // navigator.share 는 사용자 제스처 안에서 호출해야 하므로 파일 생성은 동기로 처리
    const selected = imagesData.filter(img => selectedImageIds.has(img.id));
    const files = selected.map(img =>
        dataUrlToFile(img.dataUrl, img.fileName || `sharedrop_${img.id}.${img.format || 'png'}`)
    );

    // 1순위: 선택한 전체를 한 번에 공유
    if (canShareTheseFiles(files)) {
        try {
            await navigator.share({ files });
            showToast('공유 시트에서 갤러리(사진) 앱을 선택하면 사진첩에 저장됩니다.');
            return;
        } catch (err) {
            if (err?.name === 'AbortError') return; // 사용자가 시트를 닫음
            console.warn('다중 파일 공유 실패, 폴백합니다:', err);
        }
    }

    // 2순위: 다중은 막혔지만 1장은 가능한 경우(안드로이드에서 흔함) → 첫 장만 공유 시도
    if (files.length === 1 && canShareTheseFiles([files[0]])) {
        try {
            await navigator.share({ files: [files[0]] });
            showToast('공유 시트에서 갤러리(사진) 앱을 선택하면 사진첩에 저장됩니다.');
            return;
        } catch (err) {
            if (err?.name === 'AbortError') return;
            console.warn('단일 공유도 실패, 폴백합니다:', err);
        }
    }

    // 최후: .zip 다운로드로 폴백 (기능이 아무것도 안 되는 상황 방지)
    showToast('여러 장 공유가 지원되지 않아 .zip으로 저장합니다.', true);
    await downloadSelectedAsZip();
});

// 드래그(러버밴드) 다중 선택 — 데스크톱 전용
let marqueeStart = null;
let marqueeActive = false;
if (!isTouchDevice) {
    els.dropZone.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        // 카드/버튼/셀렉트 위에서는 시작하지 않음 (빈 공간에서만)
        if (e.target.closest('.sd-card') || e.target.closest('button') || e.target.closest('select')) return;
        marqueeStart = { x: e.clientX, y: e.clientY, additive: e.shiftKey || e.metaKey || e.ctrlKey };
        marqueeActive = false;
    });
    window.addEventListener('mousemove', (e) => {
        if (!marqueeStart) return;
        const w = Math.abs(e.clientX - marqueeStart.x);
        const h = Math.abs(e.clientY - marqueeStart.y);
        if (!marqueeActive && w + h < 8) return; // 단순 클릭과 구분
        if (!marqueeActive) {
            marqueeActive = true;
            document.body.style.userSelect = 'none';
            if (!marqueeStart.additive) {
                selectedImageIds.clear(); // 새 드래그는 새 선택
            }
        }
        const x1 = Math.min(marqueeStart.x, e.clientX);
        const y1 = Math.min(marqueeStart.y, e.clientY);
        els.marquee.style.display = 'block';
        els.marquee.style.left = x1 + 'px';
        els.marquee.style.top = y1 + 'px';
        els.marquee.style.width = w + 'px';
        els.marquee.style.height = h + 'px';

        const box = { left: x1, top: y1, right: x1 + w, bottom: y1 + h };
        document.querySelectorAll('#gallery-grid .sd-card').forEach(card => {
            const r = card.getBoundingClientRect();
            const hit = !(r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom);
            const id = card.dataset.imgId;
            if (hit) selectedImageIds.add(id);
            else if (!marqueeStart.additive) selectedImageIds.delete(id);
            card.querySelector('.image-checkbox').checked = selectedImageIds.has(id);
        });
        updateSelectionUI();
    });
    window.addEventListener('mouseup', () => {
        if (!marqueeStart) return;

        // 드래그가 아니라 '빈 공간 클릭'이었다면 전체 선택 해제.
        // (드래그 임계값 8px 미만이면 marqueeActive가 false로 남아, 예전엔 선택이 그대로 유지돼
        //  선택을 푸는 방법이 사실상 없었다 — '전체 드래그 풀기 안 됨' 버그)
        if (!marqueeActive && !marqueeStart.additive && selectedImageIds.size > 0) {
            selectedImageIds.clear();
            syncCheckboxes();
            updateSelectionUI();
        }

        marqueeStart = null;
        marqueeActive = false;
        els.marquee.style.display = 'none';
        document.body.style.userSelect = '';
    });
}

// 단일 다운로드 — 모바일은 공유 시트(사진첩 저장), 데스크톱은 파일 다운로드
async function downloadSingleImage(img) {
    const fileName = img.fileName || `sharedrop_${img.id}.${img.format || 'png'}`;

    if (canShareFiles) {
        try {
            const file = dataUrlToFile(img.dataUrl, fileName);
            if (canShareTheseFiles([file])) {
                await navigator.share({ files: [file] });
                showToast('공유 시트에서 갤러리(사진) 앱을 선택하면 사진첩에 저장됩니다.');
                return;
            }
        } catch (err) {
            if (err?.name === 'AbortError') return; // 사용자가 시트를 닫음
            console.warn('공유 실패, 다운로드로 폴백합니다:', err);
        }
    }

    const a = document.createElement('a');
    a.href = img.dataUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // 안드로이드 등에서 공유가 불가능해 파일 다운로드로 처리된 경우 저장 위치를 안내
    if (isTouchDevice) {
        showToast('다운로드 폴더에 저장했습니다. (사진첩 저장은 공유 기능이 필요합니다)');
    }
}

// 선택 항목 .zip 다운로드 (공유 실패 시 폴백으로도 사용)
async function downloadSelectedAsZip() {
    if (selectedImageIds.size === 0) return;
    try {
        els.btnDownloadSelected.disabled = true;
        els.btnDownloadSelected.innerHTML = '<div class="loader mr-2 w-3 h-3 border-2 border-t-white border-slate-400"></div> 압축 중...';

        const zip = new JSZip();
        let count = 0;

        imagesData.forEach(img => {
            if (selectedImageIds.has(img.id)) {
                // dataUrl에서 base64 데이터만 추출
                const base64Data = img.dataUrl.split(',')[1];
                const ext = img.format || 'png';
                const filename = img.fileName || `image_${count + 1}.${ext}`;
                zip.file(filename, base64Data, {base64: true});
                count++;
            }
        });

        const content = await zip.generateAsync({type: "blob"});
        const a = document.createElement("a");
        a.href = URL.createObjectURL(content);
        a.download = `ShareDrop_${currentRoomId}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        showToast(`${count}개 파일 다운로드 완료!`);
        // 다운로드 후 선택 해제 (옵션)
        els.btnUnselectAll.click();

    } catch(e) {
        console.error("Zip Error:", e);
        showToast('압축 과정에서 오류가 발생했습니다.', true);
    } finally {
        els.btnDownloadSelected.disabled = false;
        els.btnDownloadSelected.innerHTML = '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg> .zip 다운로드';
    }
}

els.btnDownloadSelected.addEventListener('click', downloadSelectedAsZip);

// 앱 초기 실행 (해시 라우터 트리거) — 인증 대기 중 문서 로드가 끝난 경우도 처리
if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', handleRoute);
} else {
    handleRoute();
}

