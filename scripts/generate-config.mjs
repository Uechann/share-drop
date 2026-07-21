// 환경 변수(FIREBASE_*)로부터 js/config.js 를 생성합니다.
// - 로컬:  npm run build  (Node가 .env를 읽어 process.env에 주입)
// - Vercel: 빌드 시 대시보드에 설정된 환경 변수가 process.env로 주입됨
// 생성물(js/config.js)은 gitignore 처리되어 저장소에 커밋되지 않습니다.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 로컬 실행 시 .env 를 직접 읽어 process.env에 채움 (없으면 건너뜀).
// Vercel 등 CI에서는 .env 없이 대시보드 환경 변수가 이미 process.env에 주입되어 있음.
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        if (!(key in process.env)) process.env[key] = val;
    }
}

const FIELDS = {
    apiKey: 'FIREBASE_API_KEY',
    authDomain: 'FIREBASE_AUTH_DOMAIN',
    projectId: 'FIREBASE_PROJECT_ID',
    storageBucket: 'FIREBASE_STORAGE_BUCKET',
    messagingSenderId: 'FIREBASE_MESSAGING_SENDER_ID',
    appId: 'FIREBASE_APP_ID',
    measurementId: 'FIREBASE_MEASUREMENT_ID',
};

const config = {};
const missing = [];
for (const [key, envName] of Object.entries(FIELDS)) {
    const value = process.env[envName];
    if (!value) missing.push(envName);
    config[key] = value;
}

if (missing.length) {
    console.error('❌ 누락된 환경 변수:', missing.join(', '));
    console.error('   로컬은 .env 파일(.env.example 참고), Vercel은 대시보드 환경 변수를 확인하세요.');
    process.exit(1);
}

const banner = '// ⚠️ 자동 생성 파일 — 직접 수정하지 마세요. scripts/generate-config.mjs 가 생성합니다.\n';
const body = `export const firebaseConfig = ${JSON.stringify(config, null, 4)};\n`;

const outPath = join(__dirname, '..', 'js', 'config.js');
writeFileSync(outPath, banner + body);
console.log('✅ js/config.js 생성 완료');
