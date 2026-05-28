/**
 * shim.js — DWEM Debug Loader Shim for DCSSAdvisor
 *
 * DWEM_DEBUG='true'일 때 기본 코어 로더 대신 이 파일이 import 됩니다.
 * 1. DCSSAdvisor URL을 DWEM_MODULES 앞에 추가
 * 2. 실제 DWEM 코어 로더를 import → 모든 모듈 로드 진행
 *
 * 이 파일은 ES 모듈로 동적 import 되므로 top-level await 사용 가능.
 */

// jsDelivr CDN (CNC CSP 허용 도메인, application/javascript MIME 타입 보장)
// 커밋 해시로 고정 → CDN 캐시 완전 우회
const ADVISOR_URL =
    'https://cdn.jsdelivr.net/gh/yeklys96/dcss-advisor@1629d7cb24b3ee119569788fded79e74f5f668d2/index.js';

// DWEM_LATEST: 이전 페이지 방문 시 캐시된 commit hash, 없으면 'latest'
const LATEST = localStorage.getItem('DWEM_LATEST') || 'latest';

// DWEM_MODULES에 advisor URL 추가 (중복 방지)
try {
    const mods = JSON.parse(localStorage.getItem('DWEM_MODULES') || '[]');
    if (!mods.includes(ADVISOR_URL)) {
        mods.unshift(ADVISOR_URL);
        localStorage.setItem('DWEM_MODULES', JSON.stringify(mods));
    }
} catch (e) {
    console.warn('[DCSSAdvisor shim] DWEM_MODULES 파싱 실패:', e);
}

// 실제 DWEM 코어 로더 import (여기서 DWEM_MODULES의 모든 모듈이 로드됨)
await import(
    `https://cdn.jsdelivr.net/gh/refracta/dcss-webtiles-extension-module@${LATEST}/loader/dwem-core-loader.js`
);
