// ==UserScript==
// @name         크랙 채팅모드별 유저노트 자동변경
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  Crack 유저노트 창에서 모델 프리셋을 자동 저장하고, 채팅 모드 변경 시 서버에 자동 적용합니다.
// @match        https://crack.wrtn.ai/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    const API_BASE = 'https://crack-api.wrtn.ai/crack-gen';

    const MODE_NOTES_KEY_PREFIX = 'crack_mode_user_notes_v3';
    const LAST_APPLIED_NOTE_KEY = 'crack_last_applied_mode_user_note_v3';

    const CHAT_MODES = [
        { key: 'fablechat_1_0', label: '페이블챗 1.0', shortLabel: 'Fable' },
        { key: 'hyperchat_4_0', label: '하이퍼챗 4.0', shortLabel: 'H4' },
        { key: 'hyperchat_3_0', label: '하이퍼챗 3.0', shortLabel: 'H3' },
        { key: 'hyperchat_2_0', label: '하이퍼챗 2.0', shortLabel: 'H2' },
        { key: 'hyperchat_1_5', label: '하이퍼챗 1.5', shortLabel: 'H1.5' },
        { key: 'hyperchat', label: '하이퍼챗', shortLabel: 'Hyper' },
        { key: 'prochat_2_5', label: '프로챗 2.5', shortLabel: 'Pro2.5' },
        { key: 'prochat_1_0', label: '프로챗 1.0', shortLabel: 'Pro1.0' },
    ];

    let lastAutoAppliedModeKey = '';
    let lastAutoApplyAt = 0;
    let lastDetectedChatId = '';
    let lastDetectedModeKey = '';

    let lastAppliedUserNoteContent = '';
    let lastAppliedUserNoteIsExtend = false;
    let lastAppliedUserNoteChatId = '';
    let lastAppliedUserNoteMode = '';

    let lastSeenUserNoteTextarea = null;
    let userNoteUiSyncScheduled = false;

    let internalPatchInProgress = false;
    let pendingUserNotePatchMode = null;

    let currentServerUserNote = null;
    let selectedPresetMode = '';
    let presetSaveTimer = null;
    let pendingPresetSave = null;
    let toastTimer = null;
    let presetGuardAttached = false;

    function parseChatId() {
        const m = location.pathname.match(/\/stories\/[^/]+\/episodes\/([^/?#]+)/);
        return m ? m[1] : null;
    }

    function isChatPage() {
        return !!parseChatId();
    }

    function getModeNotesKey(chatId = parseChatId()) {
        return `${MODE_NOTES_KEY_PREFIX}_${chatId || 'global'}`;
    }

    function getModeLabel(modeKey) {
        return CHAT_MODES.find(mode => mode.key === modeKey)?.label || modeKey;
    }

    function getModeShortLabel(modeKey) {
        const mode = CHAT_MODES.find(item => item.key === modeKey);
        return mode?.shortLabel || mode?.label || modeKey;
    }

    function getModeNotes(chatId = parseChatId()) {
        const storageKey = getModeNotesKey(chatId);
        const saved = GM_getValue(storageKey, null);
        const notes = {};
        let needsMigration = !saved || typeof saved !== 'object';

        CHAT_MODES.forEach(mode => {
            notes[mode.key] = {
                content: '',
                isExtend: false,
                updatedAt: null,
                initialized: false,
            };
        });

        if (saved && typeof saved === 'object') {
            CHAT_MODES.forEach(mode => {
                const entry = saved?.[mode.key];
                const hasLegacyValue = !!entry && (
                    (typeof entry.content === 'string' && entry.content.length > 0) ||
                    !!entry.isExtend ||
                    !!entry.updatedAt
                );

                notes[mode.key] = {
                    content: typeof entry?.content === 'string'
                        ? entry.content
                        : '',
                    isExtend: !!entry?.isExtend,
                    updatedAt: entry?.updatedAt || null,
                    initialized: typeof entry?.initialized === 'boolean'
                        ? entry.initialized
                        : hasLegacyValue,
                };

                if (entry && typeof entry.initialized !== 'boolean') {
                    needsMigration = true;
                }
            });
        }

        if (needsMigration) {
            GM_setValue(storageKey, notes);
        }
        return notes;
    }

    function setModeNotes(notes, chatId = parseChatId()) {
        GM_setValue(getModeNotesKey(chatId), notes);
    }

    function escapeHtml(str) {
        return String(str ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function countChars(text) {
        return [...String(text || '')].length;
    }

    function getCookie(name) {
        const entry = document.cookie
            .split(';')
            .map(v => v.trim())
            .find(v => v.startsWith(name + '='));

        return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
    }

    function getToken() {
        return getCookie('access_token');
    }

    function buildHeaders() {
        const token = getToken();
        const wrtnId = getCookie('__w_id');

        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*',
            'platform': 'web',
            'wrtn-locale': 'ko-KR',
        };

        if (token) headers['Authorization'] = `Bearer ${token}`;
        if (wrtnId) headers['x-wrtn-id'] = wrtnId;

        return headers;
    }

    async function fetchCurrentUserNote(chatId) {
        const res = await fetch(`${API_BASE}/v3/chats/${chatId}`, {
            method: 'GET',
            headers: buildHeaders(),
            credentials: 'include',
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`현재 유저노트 조회에 실패했습니다. (${res.status}) ${text.slice(0, 160)}`);
        }

        const json = await res.json();
        const userNote = json?.data?.story?.userNote;

        return {
            content: userNote?.content ?? '',
            isExtend: !!userNote?.isExtend,
        };
    }

    async function patchUserNote(chatId, content, isExtend = false, modeKey = '') {
        if (modeKey) {
            pendingUserNotePatchMode = {
                chatId,
                modeKey,
                content: content || '',
                isExtend: !!isExtend,
                until: Date.now() + 4000,
            };
        }

        internalPatchInProgress = true;

        try {
            const res = await fetch(`${API_BASE}/v3/chats/${chatId}`, {
                method: 'PATCH',
                headers: buildHeaders(),
                credentials: 'include',
                body: JSON.stringify({
                    userNote: {
                        content,
                        isExtend,
                    },
                }),
            });

            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`유저노트 수정에 실패했습니다. (${res.status}) ${text.slice(0, 160)}`);
            }

            return res.json().catch(() => ({}));
        } finally {
            setTimeout(() => {
                internalPatchInProgress = false;
            }, 0);
        }
    }

    function rememberLastAppliedNote(chatId, modeKey, content, isExtend) {
        lastAppliedUserNoteContent = content || '';
        lastAppliedUserNoteIsExtend = !!isExtend;
        lastAppliedUserNoteChatId = chatId || '';
        lastAppliedUserNoteMode = modeKey || '';

        GM_setValue(LAST_APPLIED_NOTE_KEY, {
            chatId,
            mode: modeKey,
            content: content || '',
            isExtend: !!isExtend,
            updatedAt: Date.now(),
        });
    }

    function restoreLastAppliedNoteIfNeeded() {
        const chatId = parseChatId();
        if (!chatId) return;

        if (
            lastAppliedUserNoteChatId === chatId &&
            lastAppliedUserNoteMode
        ) {
            return;
        }

        const saved = GM_getValue(LAST_APPLIED_NOTE_KEY, null);

        if (saved && saved.chatId === chatId && saved.mode) {
            lastAppliedUserNoteContent = saved.content || '';
            lastAppliedUserNoteIsExtend = !!saved.isExtend;
            lastAppliedUserNoteChatId = saved.chatId;
            lastAppliedUserNoteMode = saved.mode || '';
        }
    }

    function getCurrentAppliedModeForChat() {
        const chatId = parseChatId();

        if (!chatId) return '';

        if (lastDetectedChatId === chatId && lastDetectedModeKey) {
            return lastDetectedModeKey;
        }

        if (
            lastAppliedUserNoteChatId === chatId &&
            lastAppliedUserNoteMode
        ) {
            return lastAppliedUserNoteMode;
        }

        const saved = GM_getValue(LAST_APPLIED_NOTE_KEY, null);

        if (saved && saved.chatId === chatId && saved.mode) {
            return saved.mode;
        }

        return '';
    }

    function getPendingPatchMode(chatId, patchedUserNote) {
        if (!pendingUserNotePatchMode) return '';

        const expired = Date.now() > pendingUserNotePatchMode.until;
        if (expired) {
            pendingUserNotePatchMode = null;
            return '';
        }

        const content = typeof patchedUserNote?.content === 'string'
            ? patchedUserNote.content
            : '';

        const isExtend = !!patchedUserNote?.isExtend;

        const matched =
            pendingUserNotePatchMode.chatId === chatId &&
            pendingUserNotePatchMode.content === content &&
            pendingUserNotePatchMode.isExtend === isExtend;

        if (!matched) return '';

        const modeKey = pendingUserNotePatchMode.modeKey;
        pendingUserNotePatchMode = null;

        return modeKey;
    }

    function getUserNoteRootFromTextarea(textarea) {
        return (
            textarea.closest('[role="dialog"]') ||
            textarea.closest('.flex.flex-col.gap-3') ||
            textarea.closest('.flex.flex-col.gap-5') ||
            textarea.parentElement
        );
    }

    function findVisibleUserNoteTextarea() {
        const marked = document.querySelector('textarea[data-mun-native-usernote="1"]');
        if (marked?.isConnected) {
            const root = getUserNoteRootFromTextarea(marked);
            const rootRect = root?.getBoundingClientRect();
            const rootStyle = root ? window.getComputedStyle(root) : null;
            const rootVisible = !!rootRect &&
                rootRect.width > 0 &&
                rootRect.height > 0 &&
                rootStyle?.display !== 'none' &&
                rootStyle?.visibility !== 'hidden';

            if (rootVisible) return marked;
        }

        const textareas = [...document.querySelectorAll('textarea:not([data-mun-preset-editor="1"])')];

        return textareas.find(textarea => {
            const rect = textarea.getBoundingClientRect();
            const style = window.getComputedStyle(textarea);

            const isVisible =
                rect.width > 0 &&
                rect.height > 0 &&
                style.display !== 'none' &&
                style.visibility !== 'hidden';

            if (!isVisible) return false;

            const placeholder = textarea.getAttribute('placeholder') || '';
            const ariaLabel = textarea.getAttribute('aria-label') || '';
            const root = getUserNoteRootFromTextarea(textarea);
            const parentText = root?.textContent || textarea.closest('div')?.textContent || '';

            const isLikelyUserNote =
                placeholder.includes('잊으면 안되는 중요한 내용') ||
                placeholder.includes('추가하고 싶은 설정') ||
                placeholder.includes('유저') ||
                placeholder.includes('노트') ||
                ariaLabel.includes('유저') ||
                ariaLabel.includes('노트') ||
                parentText.includes('유저노트') ||
                parentText.includes('유저 노트') ||
                parentText.includes('반드시 기억해 줬으면') ||
                parentText.includes('2000자 확장');

            const isProbablyChatInput =
                placeholder.includes('메시지') ||
                placeholder.includes('입력') ||
                placeholder.includes('대화') ||
                ariaLabel.includes('메시지') ||
                parentText.includes('전송');

            return isLikelyUserNote && !isProbablyChatInput;
        }) || null;
    }

    function initializeUninitializedPresets(serverNote) {
        if (!serverNote) return getModeNotes();

        const notes = getModeNotes();
        let changed = false;

        CHAT_MODES.forEach(mode => {
            if (notes[mode.key]?.initialized) return;

            notes[mode.key] = {
                content: serverNote.content || '',
                isExtend: !!serverNote.isExtend,
                updatedAt: Date.now(),
                initialized: true,
            };
            changed = true;
        });

        if (changed) {
            setModeNotes(notes);
        }

        return notes;
    }

    async function ensurePresetsInitialized(chatId) {
        if (!chatId) return getModeNotes();

        let serverNote = currentServerUserNote?.chatId === chatId
            ? currentServerUserNote
            : null;

        if (!serverNote) {
            const fetched = await fetchCurrentUserNote(chatId);
            serverNote = {
                chatId,
                content: fetched.content || '',
                isExtend: !!fetched.isExtend,
                fetchedAt: Date.now(),
            };
            currentServerUserNote = serverNote;
        }

        return initializeUninitializedPresets(serverNote);
    }

    async function syncVisibleUserNoteUIFromAppliedThenServer() {
        const chatId = parseChatId();
        if (!chatId) return;

        const textarea = findVisibleUserNoteTextarea();
        if (!textarea) return;

        lastSeenUserNoteTextarea = textarea;
        ensureInlineEditorUI(textarea);
        renderModeTabs();

        try {
            const serverNote = await fetchCurrentUserNote(chatId);

            if (parseChatId() !== chatId || findVisibleUserNoteTextarea() !== textarea) return;

            currentServerUserNote = {
                chatId,
                content: serverNote.content || '',
                isExtend: !!serverNote.isExtend,
                fetchedAt: Date.now(),
            };

            initializeUninitializedPresets(currentServerUserNote);
            renderModeTabs();

            const presetEditor = getPresetEditor();
            if (
                selectedPresetMode &&
                (presetEditor?.hidden || presetEditor?.dataset.modeKey !== selectedPresetMode)
            ) {
                showPresetEditor(textarea, selectedPresetMode);
            }

            console.log('[채팅모드별 유저노트 자동변경] 서버 유저노트 확인 및 프리셋 초기화를 완료했습니다.', {
                chatId,
                length: countChars(currentServerUserNote.content),
                isExtend: currentServerUserNote.isExtend,
            });
        } catch (err) {
            console.warn('[채팅모드별 유저노트 자동변경] 서버 유저노트 확인 실패', err);
        }
    }

    function scheduleVisibleUserNoteUiSync() {
        if (userNoteUiSyncScheduled) return;

        userNoteUiSyncScheduled = true;

        setTimeout(async () => {
            try {
                await syncVisibleUserNoteUIFromAppliedThenServer();
            } finally {
                userNoteUiSyncScheduled = false;
            }
        }, 0);
    }

    function syncPatchedUserNoteToPreset(chatId, patchedUserNote, modeKeyOverride = '') {
        if (!chatId || !patchedUserNote) return;

        const currentChatId = parseChatId();
        if (currentChatId && currentChatId !== chatId) return;

        const content = typeof patchedUserNote.content === 'string'
            ? patchedUserNote.content
            : '';

        const isExtend = !!patchedUserNote.isExtend;

        currentServerUserNote = {
            chatId,
            content,
            isExtend,
            fetchedAt: Date.now(),
        };

        const modeKey =
            modeKeyOverride ||
            getPendingPatchMode(chatId, { content, isExtend }) ||
            getCurrentAppliedModeForChat();

        if (!modeKey || !CHAT_MODES.some(mode => mode.key === modeKey)) {
            return;
        }

        const notes = getModeNotes();

        notes[modeKey] = {
            content,
            isExtend,
            updatedAt: Date.now(),
            initialized: true,
        };

        setModeNotes(notes);
        rememberLastAppliedNote(chatId, modeKey, content, isExtend);
        renderModeTabs();
        showToast(`${getModeShortLabel(modeKey)} 프리셋 저장됨`);

        console.log('[채팅모드별 유저노트 자동변경] native PATCH 유저노트를 프리셋에 동기화했습니다.', {
            chatId,
            modeKey,
            length: countChars(content),
            isExtend,
        });
    }

    async function getFetchBodyText(resource, config) {
        const body = config?.body;

        if (typeof body === 'string') {
            return body;
        }

        if (body instanceof URLSearchParams) {
            return body.toString();
        }

        if (
            resource &&
            typeof Request !== 'undefined' &&
            resource instanceof Request
        ) {
            try {
                return await resource.clone().text();
            } catch {
                return '';
            }
        }

        return '';
    }

    function getFetchUrl(resource) {
        if (typeof resource === 'string') return resource;
        return resource?.url || '';
    }

    function getFetchMethod(resource, config) {
        return String(config?.method || resource?.method || 'GET').toUpperCase();
    }

    function hookChatModeFetch() {
        const targetWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

        if (targetWindow.__crackModeUserNoteFetchHooked) return;
        targetWindow.__crackModeUserNoteFetchHooked = true;

        const originalFetch = targetWindow.fetch;

        targetWindow.fetch = async function (...args) {
            let shouldSyncPatchedUserNote = false;
            let patchedChatId = '';
            let patchedUserNote = null;

            try {
                const [resource, config] = args;

                const url = getFetchUrl(resource);
                const method = getFetchMethod(resource, config);
                const bodyText = await getFetchBodyText(resource, config);

                if (
                    url &&
                    url.includes('event-gateway.wrtn.ai/v1/track') &&
                    bodyText &&
                    bodyText.includes('select_chat_mode_btn')
                ) {
                    const parsed = JSON.parse(bodyText);

                    if (parsed?.eventName === 'select_chat_mode_btn') {
                        const chatMode = parsed?.eventProperties?.chat_mode;
                        const chatIdFromEvent = parsed?.eventProperties?.chat_id;
                        const chatId = chatIdFromEvent || parseChatId();

                        if (chatId && CHAT_MODES.some(mode => mode.key === chatMode)) {
                            lastDetectedChatId = chatId;
                            lastDetectedModeKey = chatMode;
                            renderModeTabs();
                        }

                        console.log('[채팅모드별 유저노트 자동변경 감지]', {
                            chatId,
                            chatMode,
                        });

                        setTimeout(() => {
                            applyUserNoteByChatMode(chatId, chatMode);
                        }, 300);
                    }
                }

                if (
                    !internalPatchInProgress &&
                    url &&
                    method === 'PATCH' &&
                    url.includes('crack-api.wrtn.ai/crack-gen/v3/chats/') &&
                    bodyText
                ) {
                    const parsed = JSON.parse(bodyText);

                    if (
                        parsed?.userNote &&
                        typeof parsed.userNote === 'object'
                    ) {
                        const chatIdMatch = url.match(/\/v3\/chats\/([^/?#]+)/);
                        patchedChatId = chatIdMatch?.[1] || parseChatId() || '';

                        patchedUserNote = {
                            content: typeof parsed.userNote.content === 'string'
                                ? parsed.userNote.content
                                : '',
                            isExtend: !!parsed.userNote.isExtend,
                        };

                        shouldSyncPatchedUserNote = true;
                    }
                }
            } catch (err) {
                console.warn('[채팅모드별 유저노트 자동변경 감지 실패]', err);
            }

            const response = await originalFetch.apply(this, args);

            if (shouldSyncPatchedUserNote && patchedChatId && patchedUserNote) {
                if (response?.ok) {
                    setTimeout(() => {
                        syncPatchedUserNoteToPreset(patchedChatId, patchedUserNote);
                        scheduleVisibleUserNoteUiSync();
                    }, 100);
                } else {
                    console.warn('[채팅모드별 유저노트 자동변경] PATCH 실패로 프리셋 동기화 생략', {
                        status: response?.status,
                        patchedChatId,
                    });
                }
            }

            return response;
        };
    }

    GM_addStyle(`
        #mun-inline-editor {
            width: 100%;
            height: 38px;
            min-height: 38px;
            box-sizing: border-box;
            margin: 0 0 8px;
            overflow: hidden;
            color: inherit;
            font-family: inherit;
            font-size: 12px;
        }

        .mun-chip-scroll {
            display: flex;
            align-items: center;
            gap: 6px;
            width: 100%;
            height: 38px;
            box-sizing: border-box;
            padding: 1px 2px 5px;
            overflow-x: auto;
            overflow-y: hidden;
            overscroll-behavior-x: contain;
            scrollbar-width: thin;
            -webkit-overflow-scrolling: touch;
        }

        .mun-chip {
            position: relative;
            display: inline-flex;
            flex: 0 0 auto;
            align-items: center;
            justify-content: center;
            min-height: 30px;
            box-sizing: border-box;
            border: 1px solid #dedbd7;
            border-radius: 999px;
            padding: 5px 10px;
            background: #f7f6f4;
            color: #716c66;
            font: inherit;
            font-weight: 600;
            line-height: 1;
            white-space: nowrap;
            cursor: pointer;
            transition: border-color .15s ease, background .15s ease, color .15s ease;
        }

        .mun-chip:hover {
            background: #efedeb;
            color: #35322f;
        }

        .mun-chip.is-selected {
            border-color: #7655d9;
            background: #eee9ff;
            color: #5330b8;
            box-shadow: 0 0 0 1px rgba(118, 85, 217, .08);
        }

        .mun-chip.is-active::after {
            position: absolute;
            top: 4px;
            right: 5px;
            width: 5px;
            height: 5px;
            border-radius: 50%;
            background: #7655d9;
            content: '';
        }

        .mun-chip.is-active {
            padding-right: 16px;
        }

        .mun-preset-textarea {
            display: block;
            width: 100%;
            box-sizing: border-box;
            overflow-y: auto !important;
            resize: none !important;
        }

        .mun-preset-textarea[hidden] {
            display: none !important;
        }

        #mun-toast {
            position: fixed;
            left: 50%;
            bottom: max(24px, env(safe-area-inset-bottom));
            z-index: 2147483647;
            max-width: min(88vw, 420px);
            box-sizing: border-box;
            padding: 8px 13px;
            border-radius: 999px;
            background: rgba(28, 27, 26, .92);
            color: #fff;
            font: 600 12px/1.35 sans-serif;
            text-align: center;
            word-break: keep-all;
            opacity: 0;
            pointer-events: none;
            transform: translate(-50%, 8px);
            transition: opacity .16s ease, transform .16s ease;
        }

        #mun-toast.show {
            opacity: 1;
            transform: translate(-50%, 0);
        }

        @media (prefers-color-scheme: dark) {
            .mun-chip {
                border-color: #4b4844;
                background: #302e2b;
                color: #c9c5bf;
            }

            .mun-chip:hover {
                background: #3a3733;
                color: #f0eeeb;
            }

            .mun-chip.is-selected {
                border-color: #9a7cff;
                background: #3b315c;
                color: #d9ccff;
            }

            .mun-chip.is-active::after {
                background: #b19aff;
            }
        }
    `);

    function showToast(message, duration = 1600) {
        const toast = document.getElementById('mun-toast');
        if (!toast) return;

        clearTimeout(toastTimer);
        toast.textContent = message;
        toast.classList.add('show');

        toastTimer = setTimeout(() => {
            toast.classList.remove('show');
        }, duration);
    }

    function buildUI() {
        if (!document.getElementById('mun-toast')) {
            const toast = document.createElement('div');
            toast.id = 'mun-toast';
            document.body.appendChild(toast);
        }

        attachPresetGuard();
    }

    function getNativeUserNoteTextarea() {
        const marked = document.querySelector('textarea[data-mun-native-usernote="1"]');
        if (marked?.isConnected) return marked;
        return findVisibleUserNoteTextarea();
    }

    function getPresetEditor() {
        return document.querySelector('textarea[data-mun-preset-editor="1"]');
    }

    function ensureInlineEditorUI(textarea) {
        if (!textarea) return null;

        if (!textarea.dataset.munTextareaId) {
            textarea.dataset.munTextareaId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        }
        textarea.dataset.munNativeUsernote = '1';

        const textareaId = textarea.dataset.munTextareaId;
        let container = document.getElementById('mun-inline-editor');
        let presetEditor = getPresetEditor();

        if (container?.dataset.textareaId !== textareaId) {
            container?.remove();
            container = null;
        }

        if (presetEditor?.dataset.textareaId !== textareaId) {
            presetEditor?.remove();
            presetEditor = null;
        }

        if (!container) {
            container = document.createElement('section');
            container.id = 'mun-inline-editor';
            container.dataset.textareaId = textareaId;
            container.setAttribute('aria-label', '모델별 유저노트 프리셋');
            textarea.parentElement?.insertBefore(container, textarea);
        }

        if (!presetEditor) {
            presetEditor = document.createElement('textarea');
            presetEditor.className = `${textarea.className || ''} mun-preset-textarea`.trim();
            presetEditor.dataset.munPresetEditor = '1';
            presetEditor.dataset.textareaId = textareaId;
            presetEditor.setAttribute('aria-label', '모델 프리셋 유저노트');
            presetEditor.hidden = true;
            presetEditor.spellcheck = textarea.spellcheck;
            presetEditor.addEventListener('input', schedulePresetAutoSave);
            textarea.insertAdjacentElement('afterend', presetEditor);
        }

        renderModeTabs();
        if (!selectedPresetMode) {
            showCurrentEditor(textarea);
        } else if (getModeNotes()[selectedPresetMode]?.initialized) {
            showPresetEditor(textarea, selectedPresetMode);
        }
        return container;
    }

    function getStableEditorHeight(textarea) {
        const presetEditor = getPresetEditor();
        const currentHeight = textarea && !textarea.hidden
            ? textarea.getBoundingClientRect().height
            : 0;
        const presetHeight = presetEditor && !presetEditor.hidden
            ? presetEditor.getBoundingClientRect().height
            : 0;
        const remembered = parseFloat(presetEditor?.dataset.stableHeight || '0');
        const computed = textarea ? parseFloat(window.getComputedStyle(textarea).height) : 0;

        const measured = Math.max(currentHeight, presetHeight, remembered, computed);
        return measured > 0 ? measured : 200;
    }

    function showCurrentEditor(textarea) {
        const presetEditor = getPresetEditor();
        if (!textarea || !presetEditor) return;

        presetEditor.hidden = true;
        presetEditor.dataset.modeKey = '';
        textarea.hidden = false;
    }

    function showPresetEditor(textarea, modeKey) {
        const presetEditor = getPresetEditor();
        if (!textarea || !presetEditor || !modeKey) return;

        const note = getModeNotes()[modeKey];
        if (!note?.initialized) return;

        const stableHeight = getStableEditorHeight(textarea);
        presetEditor.dataset.stableHeight = String(stableHeight);
        presetEditor.dataset.modeKey = modeKey;
        presetEditor.value = note.content || '';
        presetEditor.maxLength = note.isExtend ? 2000 : 500;
        presetEditor.placeholder = `${getModeLabel(modeKey)} 프리셋`;
        presetEditor.style.height = `${stableHeight}px`;
        presetEditor.style.minHeight = `${stableHeight}px`;
        presetEditor.style.maxHeight = `${stableHeight}px`;

        textarea.hidden = true;
        presetEditor.hidden = false;
    }

    function savePresetFromEditor(modeKey, announce = true) {
        const editor = getPresetEditor();
        const pending = pendingPresetSave?.modeKey === modeKey
            ? pendingPresetSave
            : null;
        const chatId = pending?.chatId || parseChatId();
        const content = pending
            ? pending.content
            : editor?.dataset.modeKey === modeKey
                ? editor.value || ''
                : null;

        if (!chatId || !modeKey || content === null) return false;

        const notes = getModeNotes(chatId);
        const previous = notes[modeKey] || {
            content: '',
            isExtend: false,
            updatedAt: null,
            initialized: true,
        };

        notes[modeKey] = {
            content,
            isExtend: !!previous.isExtend,
            updatedAt: Date.now(),
            initialized: true,
        };

        setModeNotes(notes, chatId);
        pendingPresetSave = null;
        renderModeTabs();

        if (announce) {
            showToast(`${getModeShortLabel(modeKey)} 프리셋 저장됨`);
        }

        return true;
    }

    function flushPresetAutoSave(announce = true) {
        clearTimeout(presetSaveTimer);
        presetSaveTimer = null;

        const modeKey = pendingPresetSave?.modeKey || selectedPresetMode;
        if (!pendingPresetSave || !modeKey) return false;
        return savePresetFromEditor(modeKey, announce);
    }

    function schedulePresetAutoSave() {
        const editor = getPresetEditor();
        const modeKey = selectedPresetMode;
        const chatId = parseChatId();

        if (!editor || !chatId || !modeKey || editor.dataset.modeKey !== modeKey) return;

        pendingPresetSave = {
            chatId,
            modeKey,
            content: editor.value || '',
        };

        clearTimeout(presetSaveTimer);
        presetSaveTimer = setTimeout(() => {
            presetSaveTimer = null;
            savePresetFromEditor(modeKey, true);
        }, 320);
    }

    async function selectEditorView(modeKey = '') {
        const chatId = parseChatId();
        const textarea = getNativeUserNoteTextarea();
        if (!chatId || !textarea) return;

        if (selectedPresetMode && selectedPresetMode !== modeKey) {
            flushPresetAutoSave(false);
        }

        selectedPresetMode = modeKey;
        renderModeTabs();

        if (!modeKey) {
            showCurrentEditor(textarea);
            return;
        }

        try {
            await ensurePresetsInitialized(chatId);
        } catch (err) {
            console.error('[채팅모드별 유저노트 자동변경] 프리셋 초기화 실패', err);
            if (selectedPresetMode === modeKey) {
                selectedPresetMode = '';
                showCurrentEditor(textarea);
                renderModeTabs();
                showToast('프리셋 초기화 실패');
            }
            return;
        }

        if (selectedPresetMode !== modeKey || parseChatId() !== chatId) return;
        showPresetEditor(textarea, modeKey);
    }

    function renderModeTabs() {
        const container = document.getElementById('mun-inline-editor');
        if (!container) return;

        const activeMode = getCurrentAppliedModeForChat();

        const chips = CHAT_MODES.map(mode => {
            const selected = selectedPresetMode === mode.key;
            const active = activeMode === mode.key;

            return `
                <button
                    type="button"
                    class="mun-chip${selected ? ' is-selected' : ''}${active ? ' is-active' : ''}"
                    data-mun-mode="${escapeHtml(mode.key)}"
                    title="${escapeHtml(mode.label)}${active ? ' · 현재 모델' : ''}"
                    aria-pressed="${selected ? 'true' : 'false'}"
                >${escapeHtml(mode.shortLabel || mode.label)}</button>
            `;
        }).join('');

        container.innerHTML = `
            <div class="mun-chip-scroll" role="tablist" aria-label="유저노트 보기 선택">
                <button
                    type="button"
                    class="mun-chip${selectedPresetMode ? '' : ' is-selected'}"
                    data-mun-current
                    aria-pressed="${selectedPresetMode ? 'false' : 'true'}"
                >현재</button>
                ${chips}
            </div>
        `;

        container.querySelector('[data-mun-current]')?.addEventListener('click', () => {
            selectEditorView('');
        });

        container.querySelectorAll('[data-mun-mode]').forEach(button => {
            button.addEventListener('click', () => {
                selectEditorView(button.dataset.munMode || '');
            });
        });
    }

    function isLikelyNativeSaveButton(button) {
        if (!button) return false;

        const text = (button.textContent || '').replace(/\s+/g, '').trim();
        const ariaLabel = (button.getAttribute('aria-label') || '').replace(/\s+/g, '').trim();
        const title = (button.getAttribute('title') || '').replace(/\s+/g, '').trim();
        const type = (button.getAttribute('type') || '').toLowerCase();
        const joined = `${text} ${ariaLabel} ${title}`;

        return (
            joined.includes('수정') ||
            joined.includes('저장') ||
            joined.includes('완료') ||
            joined.includes('확인') ||
            type === 'submit'
        );
    }

    function attachPresetGuard() {
        if (presetGuardAttached) return;
        presetGuardAttached = true;

        const guard = event => {
            if (!selectedPresetMode) return;

            const button = event.target?.closest?.('button');
            if (!button) return;

            const nativeTextarea = getNativeUserNoteTextarea();
            const root = nativeTextarea ? getUserNoteRootFromTextarea(nativeTextarea) : null;
            if (root && !root.contains(button)) return;

            const isExtendSwitch = button.matches('button[role="switch"]');
            const isSave = isLikelyNativeSaveButton(button);
            if (!isExtendSwitch && !isSave) return;

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();

            if (isSave) {
                flushPresetAutoSave(true);
            }
        };

        document.addEventListener('pointerdown', guard, true);
        document.addEventListener('click', guard, true);
    }

    async function applyUserNoteByChatMode(chatId, chatMode) {
        if (!chatId || !chatMode) return;

        if (pendingPresetSave?.chatId === chatId) {
            flushPresetAutoSave(false);
        }

        if (CHAT_MODES.some(mode => mode.key === chatMode)) {
            lastDetectedChatId = chatId;
            lastDetectedModeKey = chatMode;
        }

        let notes;

        try {
            notes = await ensurePresetsInitialized(chatId);
        } catch (err) {
            console.error('[채팅 모드 유저노트 프리셋 초기화]', err);
            showToast('프리셋 초기화 실패');
            return;
        }

        const note = notes[chatMode];

        if (!note) {
            return;
        }

        if (!note.content) {
            rememberLastAppliedNote(chatId, chatMode, '', !!note.isExtend);
            renderModeTabs();
            return;
        }

        const token = getToken();

        if (!token) {
            showToast('인증 토큰을 찾지 못했습니다.');
            return;
        }

        const applyKey = `${chatId}:${chatMode}`;
        const now = Date.now();

        if (lastAutoAppliedModeKey === applyKey && now - lastAutoApplyAt < 2500) {
            return;
        }

        lastAutoAppliedModeKey = applyKey;
        lastAutoApplyAt = now;

        try {
            await patchUserNote(chatId, note.content, !!note.isExtend, chatMode);

            rememberLastAppliedNote(chatId, chatMode, note.content, !!note.isExtend);
            currentServerUserNote = {
                chatId,
                content: note.content,
                isExtend: !!note.isExtend,
                fetchedAt: Date.now(),
            };

            renderModeTabs();
            showToast(`${getModeShortLabel(chatMode)} 유저노트 적용됨`);
        } catch (err) {
            console.error('[채팅 모드 유저노트 자동 적용]', err);
            showToast('자동 적용 실패');
        }
    }

    function init() {
        buildUI();

        restoreLastAppliedNoteIfNeeded();

        if (!isChatPage()) {
            return;
        }

        const textarea = findVisibleUserNoteTextarea();
        if (textarea) scheduleVisibleUserNoteUiSync();
    }

    let lastUrl = location.href;

    const observer = new MutationObserver(() => {
        if (!document.body) return;

        if (!document.getElementById('mun-toast')) {
            init();
        }

        const userNoteTextarea = findVisibleUserNoteTextarea();

        if (userNoteTextarea && userNoteTextarea !== lastSeenUserNoteTextarea) {
            lastSeenUserNoteTextarea = userNoteTextarea;
            scheduleVisibleUserNoteUiSync();
        }

        if (!userNoteTextarea && lastSeenUserNoteTextarea) {
            flushPresetAutoSave(false);
            lastSeenUserNoteTextarea = null;
            selectedPresetMode = '';
            currentServerUserNote = null;
        }

        if (location.href !== lastUrl) {
            flushPresetAutoSave(false);
            lastUrl = location.href;

            lastAutoAppliedModeKey = '';
            lastAutoApplyAt = 0;
            lastDetectedChatId = '';
            lastDetectedModeKey = '';
            lastSeenUserNoteTextarea = null;
            pendingUserNotePatchMode = null;
            selectedPresetMode = '';
            currentServerUserNote = null;

            setTimeout(() => {
                init();
            }, 500);
        }
    });

    function start() {
        hookChatModeFetch();

        init();

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
