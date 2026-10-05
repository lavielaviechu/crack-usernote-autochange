// ==UserScript==
// @name         크랙 채팅모드별 유저노트 자동변경
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Crack 유저노트 창에서 채팅방별 모델 프리셋을 편집하고, 채팅 모드 변경 시 자동 적용합니다.
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
    let lastSyncedUserNoteKey = '';
    let userNoteUiSyncScheduled = false;
    let suppressDraftCapture = false;

    let editingUserNoteDraft = null;

    let saveInterceptorAttached = false;
    let saveCommitTimer = null;
    let lastPresetSaveInterceptAt = 0;

    let internalPatchInProgress = false;
    let pendingUserNotePatchMode = null;

    let editorSession = null;
    let currentServerUserNote = null;
    let currentEditorDraft = null;
    const presetEditorDrafts = new Map();

    function parseChatId() {
        const m = location.pathname.match(/\/stories\/[^/]+\/episodes\/([^/?#]+)/);
        return m ? m[1] : null;
    }

    function isChatPage() {
        return !!parseChatId();
    }

    function getModeNotesKey() {
        const chatId = parseChatId();
        return `${MODE_NOTES_KEY_PREFIX}_${chatId || 'global'}`;
    }

    function getModeLabel(modeKey) {
        return CHAT_MODES.find(mode => mode.key === modeKey)?.label || modeKey;
    }

    function getModeNotes() {
        const saved = GM_getValue(getModeNotesKey(), null);
        const notes = {};

        CHAT_MODES.forEach(mode => {
            notes[mode.key] = {
                content: '',
                isExtend: false,
                updatedAt: null,
            };
        });

        if (saved && typeof saved === 'object') {
            CHAT_MODES.forEach(mode => {
                notes[mode.key] = {
                    content: typeof saved?.[mode.key]?.content === 'string'
                        ? saved[mode.key].content
                        : '',
                    isExtend: !!saved?.[mode.key]?.isExtend,
                    updatedAt: saved?.[mode.key]?.updatedAt || null,
                };
            });
        }

        if (!saved || typeof saved !== 'object') {
            GM_setValue(getModeNotesKey(), notes);
        }
        return notes;
    }

    function setModeNotes(notes) {
        GM_setValue(getModeNotesKey(), notes);
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

        lastSyncedUserNoteKey = '';

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
        const textareas = [...document.querySelectorAll('textarea')];

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

    function setDisplayTextareaValueOnly(textarea, value) {
        suppressDraftCapture = true;

        const valueSetter = Object.getOwnPropertyDescriptor(textarea, 'value')?.set;
        const prototype = Object.getPrototypeOf(textarea);
        const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

        if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
            prototypeValueSetter.call(textarea, value);
        } else if (valueSetter) {
            valueSetter.call(textarea, value);
        } else {
            textarea.value = value;
        }

        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        setTimeout(() => {
            suppressDraftCapture = false;
        }, 0);
    }

    function updateUserNoteCounterUI(textarea, content, isExtend) {
        const root = getUserNoteRootFromTextarea(textarea);
        if (!root) return;

        const maxLength = isExtend ? 2000 : 500;
        const length = countChars(content);

        const spans = [...root.querySelectorAll('span')];

        const counterSpan = spans.find(span => {
            const text = span.textContent?.trim() || '';
            return /^\d+\s*\/\s*\d+$/.test(text);
        });

        if (!counterSpan) return;

        const nextText = `${length}/${maxLength}`;
        if (counterSpan.textContent !== nextText) {
            counterSpan.textContent = nextText;
        }
    }

    function updateUserNoteExtendSwitchUI(textarea, isExtend) {
        const root = getUserNoteRootFromTextarea(textarea);
        if (!root) return;

        const switchBtn = root.querySelector('button[role="switch"]');
        if (!switchBtn) return;

        const nextChecked = isExtend ? 'true' : 'false';
        const nextState = isExtend ? 'checked' : 'unchecked';

        if (switchBtn.getAttribute('aria-checked') !== nextChecked) {
            switchBtn.setAttribute('aria-checked', nextChecked);
        }

        if (switchBtn.getAttribute('data-state') !== nextState) {
            switchBtn.setAttribute('data-state', nextState);
        }

        const thumb = switchBtn.querySelector('span');
        if (thumb && thumb.getAttribute('data-state') !== nextState) {
            thumb.setAttribute('data-state', nextState);
        }
    }

    function syncUserNoteTextareaHeightLikeCrack(textarea) {
        if (!textarea) return;

        const computed = window.getComputedStyle(textarea);

        const minHeight = parseFloat(computed.minHeight) || 200;
        const maxHeight = parseFloat(computed.maxHeight) || 386;

        const previousOverflowY = textarea.style.overflowY;

        textarea.style.height = 'auto';

        const nextHeight = Math.max(
            minHeight,
            Math.min(textarea.scrollHeight, maxHeight)
        );

        textarea.style.height = `${nextHeight}px`;

        if (textarea.scrollHeight > maxHeight) {
            textarea.style.overflowY = 'auto';
        } else {
            textarea.style.overflowY = previousOverflowY || '';
        }
    }

    function getVisibleUserNoteExtendState(textarea) {
        const root = getUserNoteRootFromTextarea(textarea);
        if (!root) return !!lastAppliedUserNoteIsExtend;

        const switchBtn = root.querySelector('button[role="switch"]');
        if (!switchBtn) return !!lastAppliedUserNoteIsExtend;

        const ariaChecked = switchBtn.getAttribute('aria-checked');
        const dataState = switchBtn.getAttribute('data-state');

        if (ariaChecked === 'true' || dataState === 'checked') return true;
        if (ariaChecked === 'false' || dataState === 'unchecked') return false;

        return !!lastAppliedUserNoteIsExtend;
    }

    function getPresetDraftKey(chatId, modeKey) {
        return `${chatId}:${modeKey}`;
    }

    function updateEditorSessionFromTextarea(textarea, markDirty = true) {
        const chatId = parseChatId();
        if (!textarea || !chatId || editorSession?.chatId !== chatId) return;

        editorSession.content = textarea.value || '';
        editorSession.isExtend = getVisibleUserNoteExtendState(textarea);
        if (markDirty) editorSession.dirty = true;

        if (editorSession.kind === 'preset' && editorSession.modeKey) {
            presetEditorDrafts.set(getPresetDraftKey(chatId, editorSession.modeKey), {
                content: editorSession.content,
                isExtend: editorSession.isExtend,
                dirty: !!editorSession.dirty,
            });
        } else if (editorSession.kind === 'current' && editorSession.dirty) {
            currentEditorDraft = {
                chatId,
                content: editorSession.content,
                isExtend: editorSession.isExtend,
                dirty: true,
            };
        }

        renderModeSlots();
    }

    function captureEditingUserNoteDraft(textarea) {
        if (!textarea || suppressDraftCapture) return;

        const chatId = parseChatId();
        if (!chatId) return;

        if (editorSession?.chatId === chatId && editorSession.kind === 'preset') {
            updateEditorSessionFromTextarea(textarea, true);
            return;
        }

        if (editorSession?.chatId === chatId && editorSession.kind === 'current') {
            editorSession.content = textarea.value || '';
            editorSession.isExtend = getVisibleUserNoteExtendState(textarea);
            editorSession.dirty = true;
            currentEditorDraft = {
                chatId,
                content: editorSession.content,
                isExtend: editorSession.isExtend,
                dirty: true,
            };
            renderModeSlots();
        }

        const modeKey = getCurrentAppliedModeForChat();

        if (!modeKey) {
            console.log('[채팅모드별 유저노트 자동변경] 현재 적용 모드를 알 수 없어 draft를 저장하지 않았습니다.');
            return;
        }

        editingUserNoteDraft = {
            chatId,
            modeKey,
            content: textarea.value || '',
            isExtend: getVisibleUserNoteExtendState(textarea),
            updatedAt: Date.now(),
        };

        console.log('[채팅모드별 유저노트 자동변경] 유저노트 draft 갱신', {
            chatId,
            modeKey,
            length: countChars(editingUserNoteDraft.content),
            isExtend: editingUserNoteDraft.isExtend,
        });
    }

    function clearEditingUserNoteDraft(reason = '') {
        if (editingUserNoteDraft) {
            console.log('[채팅모드별 유저노트 자동변경] 유저노트 draft 폐기', {
                reason,
                chatId: editingUserNoteDraft.chatId,
                modeKey: editingUserNoteDraft.modeKey,
                length: countChars(editingUserNoteDraft.content),
            });
        }

        editingUserNoteDraft = null;
    }

    async function commitEditingUserNoteDraft(textarea = null) {
        const chatId = parseChatId();
        if (!chatId) return false;

        if (editorSession?.chatId === chatId && editorSession.kind === 'preset') {
            return false;
        }

        let draft = editingUserNoteDraft;

        if (!draft && textarea) {
            const modeKey = getCurrentAppliedModeForChat();

            if (modeKey) {
                draft = {
                    chatId,
                    modeKey,
                    content: textarea.value || '',
                    isExtend: getVisibleUserNoteExtendState(textarea),
                    updatedAt: Date.now(),
                };
            }
        }

        if (!draft) {
            console.log('[채팅모드별 유저노트 자동변경] 확정할 draft가 없습니다.');
            return false;
        }

        if (draft.chatId !== chatId) {
            console.log('[채팅모드별 유저노트 자동변경] draft 채팅방이 현재 채팅방과 달라 확정하지 않았습니다.', {
                draftChatId: draft.chatId,
                currentChatId: chatId,
            });
            return false;
        }

        const notes = getModeNotes();

        notes[draft.modeKey] = {
            content: draft.content || '',
            isExtend: !!draft.isExtend,
            updatedAt: Date.now(),
        };

        setModeNotes(notes);

        rememberLastAppliedNote(
            draft.chatId,
            draft.modeKey,
            draft.content || '',
            !!draft.isExtend
        );

        renderModeSlots();

        try {
            await patchUserNote(
                draft.chatId,
                draft.content || '',
                !!draft.isExtend,
                draft.modeKey
            );

            setStatus(`${getModeLabel(draft.modeKey)} 프리셋에 유저노트 저장값을 반영했습니다.`);
            showToast(`${getModeLabel(draft.modeKey)} 프리셋 반영 완료`);

            console.log('[채팅모드별 유저노트 자동변경] draft 확정 완료', {
                chatId: draft.chatId,
                modeKey: draft.modeKey,
                length: countChars(draft.content),
                isExtend: !!draft.isExtend,
            });

            currentServerUserNote = {
                chatId: draft.chatId,
                content: draft.content || '',
                isExtend: !!draft.isExtend,
                fetchedAt: Date.now(),
            };
            if (editorSession?.chatId === draft.chatId && editorSession.kind === 'current') {
                editorSession.content = draft.content || '';
                editorSession.isExtend = !!draft.isExtend;
                editorSession.dirty = false;
                editorSession.loading = false;
            }
            currentEditorDraft = null;
            clearEditingUserNoteDraft('committed');
            renderModeSlots();
            return true;
        } catch (err) {
            console.error('[채팅모드별 유저노트 자동변경] draft 서버 저장 실패', err);
            setStatus('프리셋에는 반영했지만 서버 저장 중 오류가 발생했습니다.');
            showToast('서버 저장 실패');
            return false;
        }
    }

    function attachUserNoteDraftTracker(textarea) {
        if (!textarea) return;

        const capture = () => {
            if (suppressDraftCapture) return;
            captureEditingUserNoteDraft(textarea);
        };

        if (textarea.dataset.modeUserNoteDraftTrackerAttached !== '1') {
            textarea.dataset.modeUserNoteDraftTrackerAttached = '1';
            textarea.addEventListener('input', capture);
            textarea.addEventListener('change', capture);
            textarea.addEventListener('keyup', capture);
            textarea.addEventListener('paste', () => {
                setTimeout(capture, 0);
            });
            textarea.addEventListener('compositionend', capture);
        }

        const root = getUserNoteRootFromTextarea(textarea);
        const switchBtn = root?.querySelector('button[role="switch"]');
        if (switchBtn && switchBtn.dataset.modeUserNoteDraftTrackerAttached !== '1') {
            switchBtn.dataset.modeUserNoteDraftTrackerAttached = '1';
            switchBtn.addEventListener('click', () => setTimeout(capture, 0));
        }
    }

    function isLikelyUserNoteSaveButton(button) {
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

    function attachUserNoteSaveInterceptor() {
        if (saveInterceptorAttached) return;

        saveInterceptorAttached = true;

        const handlePresetExtendSwitch = event => {
            const switchBtn = event.target?.closest?.('button[role="switch"]');
            if (!switchBtn) return;

            const chatId = parseChatId();
            const textarea = findVisibleUserNoteTextarea();
            if (!chatId || !textarea || editorSession?.chatId !== chatId || editorSession.kind !== 'preset') return;

            const root = getUserNoteRootFromTextarea(textarea);
            if (root && !root.contains(switchBtn)) return;

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();

            editorSession.isExtend = !editorSession.isExtend;
            editorSession.content = textarea.value || '';
            editorSession.dirty = true;
            presetEditorDrafts.set(getPresetDraftKey(chatId, editorSession.modeKey), {
                content: editorSession.content,
                isExtend: editorSession.isExtend,
                dirty: true,
            });

            updateUserNoteCounterUI(textarea, editorSession.content, editorSession.isExtend);
            updateUserNoteExtendSwitchUI(textarea, editorSession.isExtend);
            renderModeSlots();
        };

        const handleSave = event => {
            const button = event.target?.closest?.('button');
            if (!button) return;

            const textarea = findVisibleUserNoteTextarea();
            if (!textarea) return;

            const dialog = textarea.closest('[role="dialog"]');

            if (dialog && !dialog.contains(button)) return;

            if (!isLikelyUserNoteSaveButton(button)) return;

            const chatId = parseChatId();
            if (editorSession?.chatId === chatId && editorSession.kind === 'preset') {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();

                const now = Date.now();
                if (event.type === 'pointerdown' || now - lastPresetSaveInterceptAt > 500) {
                    lastPresetSaveInterceptAt = now;
                    saveSelectedPreset();
                }
                return;
            }

            const buttonText = (button.textContent || '').replace(/\s+/g, '').trim();

            console.log('[채팅모드별 유저노트 자동변경] 유저노트 저장/수정 버튼 감지', {
                buttonText,
                disabled: button.disabled,
                textareaLength: countChars(textarea.value || ''),
            });

            if (button.disabled) {
                console.log('[채팅모드별 유저노트 자동변경] 수정 버튼이 disabled 상태라 확정 저장을 건너뜁니다.');
                return;
            }

            captureEditingUserNoteDraft(textarea);

            clearTimeout(saveCommitTimer);
            saveCommitTimer = setTimeout(() => {
                commitEditingUserNoteDraft(textarea);
            }, 80);
        };

        document.addEventListener('click', handlePresetExtendSwitch, true);
        document.addEventListener('pointerdown', handleSave, true);
        document.addEventListener('click', handleSave, true);
    }

    async function syncVisibleUserNoteUIFromAppliedThenServer() {
        const chatId = parseChatId();
        if (!chatId) return;

        const textarea = findVisibleUserNoteTextarea();
        if (!textarea) return;

        attachUserNoteDraftTracker(textarea);
        restoreLastAppliedNoteIfNeeded();

        const isNewEditor =
            editorSession?.textarea !== textarea ||
            editorSession?.chatId !== chatId;

        lastSeenUserNoteTextarea = textarea;

        if (isNewEditor) {
            editorSession = {
                chatId,
                textarea,
                kind: 'current',
                modeKey: '',
                content: textarea.value || '',
                isExtend: getVisibleUserNoteExtendState(textarea),
                dirty: false,
                loading: true,
            };
            currentServerUserNote = {
                chatId,
                content: textarea.value || '',
                isExtend: getVisibleUserNoteExtendState(textarea),
                fetchedAt: 0,
                pending: true,
            };
            lastSyncedUserNoteKey = '';
        }

        ensureInlineEditorUI(textarea);
        renderModeSlots();

        try {
            const serverNote = await fetchCurrentUserNote(chatId);

            if (parseChatId() !== chatId || findVisibleUserNoteTextarea() !== textarea) return;

            const content = serverNote.content || '';
            const isExtend = !!serverNote.isExtend;
            const serverKey = `${chatId}:server:${countChars(content)}:${isExtend}:${content.slice(0, 40)}`;

            currentServerUserNote = { chatId, content, isExtend, fetchedAt: Date.now() };
            lastSyncedUserNoteKey = serverKey;

            if (
                editorSession?.chatId === chatId &&
                editorSession.kind === 'current' &&
                !editorSession.dirty
            ) {
                editorSession.content = content;
                editorSession.isExtend = isExtend;
                editorSession.loading = false;
                setDisplayTextareaValueOnly(textarea, content);
                updateUserNoteCounterUI(textarea, content, isExtend);
                updateUserNoteExtendSwitchUI(textarea, isExtend);
                syncUserNoteTextareaHeightLikeCrack(textarea);
                currentEditorDraft = null;
            }

            renderModeSlots();

            console.log('[채팅모드별 유저노트 자동변경] 유저노트 창을 서버값으로 검증 동기화했습니다.', {
                chatId,
                length: countChars(content),
                isExtend,
            });
        } catch (err) {
            console.warn('[채팅모드별 유저노트 자동변경] 서버값 검증 실패', err);
            if (editorSession?.chatId === chatId) {
                editorSession.loading = false;
                renderModeSlots();
            }
        }
    }

    function scheduleVisibleUserNoteUiSync() {
        if (userNoteUiSyncScheduled) return;

        userNoteUiSyncScheduled = true;

        setTimeout(() => {
            syncVisibleUserNoteUIFromAppliedThenServer();
        }, 0);

        setTimeout(() => {
            syncVisibleUserNoteUIFromAppliedThenServer();
            userNoteUiSyncScheduled = false;
        }, 350);
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

        if (editorSession?.chatId === chatId && editorSession.kind === 'current') {
            editorSession.content = content;
            editorSession.isExtend = isExtend;
            editorSession.dirty = false;
            editorSession.loading = false;
        }
        currentEditorDraft = null;

        const modeKey =
            modeKeyOverride ||
            getPendingPatchMode(chatId, { content, isExtend }) ||
            getCurrentAppliedModeForChat();

        if (!modeKey) {
            console.log('[채팅모드별 유저노트 자동변경] 현재 적용 모드를 알 수 없어 PATCH 유저노트를 프리셋에 반영하지 않았습니다.');
            renderModeSlots();
            return;
        }

        const notes = getModeNotes();

        notes[modeKey] = {
            content,
            isExtend,
            updatedAt: Date.now(),
        };

        setModeNotes(notes);

        rememberLastAppliedNote(
            chatId,
            modeKey,
            content,
            isExtend
        );

        renderModeSlots();

        setStatus(`${getModeLabel(modeKey)} 프리셋에 유저노트 수정값을 반영했습니다.`);

        console.log('[채팅모드별 유저노트 자동변경] PATCH 유저노트를 프리셋에 동기화했습니다.', {
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
                            renderModeSlots();
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
            box-sizing: border-box;
            margin: 0 0 6px;
            color: inherit;
            font-family: inherit;
            font-size: 12px;
        }

        #mun-inline-footer {
            width: 100%;
            box-sizing: border-box;
            margin: 6px 0 0;
            color: inherit;
            font-family: inherit;
            font-size: 12px;
        }

        .mun-heading {
            display: flex;
            align-items: center;
            gap: 5px;
            min-width: 0;
            margin: 0 2px 8px;
            color: #77736f;
            line-height: 1.35;
        }

        .mun-heading strong {
            overflow: hidden;
            color: #262421;
            font-weight: 650;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .mun-heading-sep { opacity: .55; }

        .mun-chip-scroll {
            display: flex;
            gap: 6px;
            width: 100%;
            padding: 1px 2px 6px;
            overflow-x: auto;
            overscroll-behavior-x: contain;
            scrollbar-width: thin;
            -webkit-overflow-scrolling: touch;
        }

        .mun-chip {
            position: relative;
            display: inline-flex;
            align-items: center;
            gap: 5px;
            flex: 0 0 auto;
            min-height: 30px;
            box-sizing: border-box;
            border: 1px solid #dedbd7;
            border-radius: 999px;
            padding: 5px 10px;
            background: #f7f6f4;
            color: #5d5954;
            font: inherit;
            font-weight: 600;
            line-height: 1;
            white-space: nowrap;
            cursor: pointer;
            transition: border-color .15s ease, background .15s ease, color .15s ease;
        }

        .mun-chip:hover { background: #efedeb; }

        .mun-chip.is-empty { color: #98938d; }

        .mun-note-dot {
            width: 5px;
            height: 5px;
            box-sizing: border-box;
            border: 1px solid currentColor;
            border-radius: 50%;
            opacity: .65;
        }

        .mun-chip.has-note .mun-note-dot {
            border-color: #7d756e;
            background: #7d756e;
            opacity: .9;
        }

        .mun-chip.is-selected {
            border-color: #7655d9;
            background: #eee9ff;
            color: #5330b8;
            box-shadow: 0 0 0 1px rgba(118, 85, 217, .08);
        }

        .mun-chip.is-active { padding-right: 18px; }

        .mun-chip.is-active i {
            position: absolute;
            top: 6px;
            right: 7px;
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: #7354d6;
            box-shadow: 0 0 0 2px #f7f6f4;
        }

        .mun-chip.is-active.is-selected i { box-shadow: 0 0 0 2px #eee9ff; }

        .mun-current { font-weight: 700; }

        .mun-footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            min-width: 0;
            margin: 4px 2px 0;
        }

        #mun-status {
            min-width: 0;
            min-height: 0;
            margin: 0;
            overflow: hidden;
            color: #77736f;
            line-height: 1.35;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .mun-actions {
            display: flex;
            flex: 0 0 auto;
            flex-wrap: nowrap;
            align-items: center;
            gap: 3px;
        }

        .mun-action {
            border: 0;
            border-radius: 6px;
            padding: 5px 7px;
            background: transparent;
            color: #6d6862;
            font: inherit;
            font-weight: 600;
            white-space: nowrap;
            cursor: pointer;
        }

        .mun-action:hover { background: #efedeb; color: #292724; }
        .mun-action.is-primary { color: #6541ca; }

        .mun-context-note {
            margin: 5px 2px 0;
            color: #9a958f;
            font-size: 11px;
            line-height: 1.35;
        }

        @media (max-width: 560px) {
            .mun-heading { flex-wrap: wrap; }
            .mun-footer { align-items: flex-start; flex-direction: column; }
            .mun-actions { width: 100%; overflow-x: auto; padding-bottom: 2px; }
            #mun-status { max-width: 100%; white-space: normal; }
            .mun-context-note { display: none; }
        }

        @media (prefers-color-scheme: dark) {
            .mun-heading { color: #aaa6a1; }
            .mun-heading strong { color: #f0eeeb; }
            .mun-chip { border-color: #4b4844; background: #302e2b; color: #d1cdc8; }
            .mun-chip:hover { background: #3a3733; }
            .mun-chip.is-empty { color: #8f8a84; }
            .mun-chip.is-selected { border-color: #9a7cff; background: #3b315c; color: #d9ccff; }
            .mun-chip.is-active i { box-shadow: 0 0 0 2px #302e2b; background: #a98fff; }
            .mun-chip.is-active.is-selected i { box-shadow: 0 0 0 2px #3b315c; }
            #mun-status, .mun-action { color: #aaa6a1; }
            .mun-action:hover { background: #3a3733; color: #f0eeeb; }
            .mun-action.is-primary { color: #baa5ff; }
            .mun-context-note { color: #817d78; }
        }
    `);

    function showToast(message, duration = 2200) {
        const toast = document.getElementById('mun-toast');
        if (!toast) return;

        toast.textContent = message;
        toast.classList.add('show');

        setTimeout(() => {
            toast.classList.remove('show');
        }, duration);
    }

    function setStatus(message) {
        const el = document.getElementById('mun-status');
        if (el) el.textContent = message;
    }

    function buildUI() {
        document.getElementById('mun-toggle-btn')?.remove();
        document.getElementById('mun-panel')?.remove();

        if (!document.getElementById('mun-toast')) {
            const toast = document.createElement('div');
            toast.id = 'mun-toast';
            document.body.appendChild(toast);
        }
    }

    function ensureInlineEditorUI(textarea) {
        if (!textarea) return null;

        let container = document.getElementById('mun-inline-editor');
        let footer = document.getElementById('mun-inline-footer');

        if (container?.dataset.textareaId !== textarea.dataset.munTextareaId) {
            container?.remove();
            footer?.remove();
            container = null;
            footer = null;
        }

        if (footer?.dataset.textareaId !== textarea.dataset.munTextareaId) {
            footer.remove();
            footer = null;
        }

        if (!textarea.dataset.munTextareaId) {
            textarea.dataset.munTextareaId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        }

        if (!container) {
            container = document.createElement('section');
            container.id = 'mun-inline-editor';
            container.dataset.textareaId = textarea.dataset.munTextareaId;
            container.setAttribute('aria-label', '모델별 유저노트 프리셋');
            textarea.parentElement?.insertBefore(container, textarea);
        }

        if (!footer) {
            footer = document.createElement('section');
            footer.id = 'mun-inline-footer';
            footer.dataset.textareaId = textarea.dataset.munTextareaId;
            footer.setAttribute('aria-label', '모델별 유저노트 프리셋 상태와 작업');
            textarea.insertAdjacentElement('afterend', footer);
        }

        return container;
    }

    function applyEditorSessionToNativeTextarea() {
        const textarea = findVisibleUserNoteTextarea();
        if (!textarea || !editorSession) return;

        setDisplayTextareaValueOnly(textarea, editorSession.content || '');
        updateUserNoteCounterUI(textarea, editorSession.content || '', !!editorSession.isExtend);
        updateUserNoteExtendSwitchUI(textarea, !!editorSession.isExtend);
        syncUserNoteTextareaHeightLikeCrack(textarea);
    }

    function selectEditorView(kind, modeKey = '') {
        const chatId = parseChatId();
        const textarea = findVisibleUserNoteTextarea();
        if (!chatId || !textarea) return;

        if (editorSession?.chatId === chatId) {
            updateEditorSessionFromTextarea(textarea, false);
        }

        if (kind === 'current') {
            const draft = currentEditorDraft?.chatId === chatId
                ? currentEditorDraft
                : editingUserNoteDraft?.chatId === chatId
                    ? editingUserNoteDraft
                    : null;
            const source = draft || currentServerUserNote || {
                content: textarea.value || '',
                isExtend: getVisibleUserNoteExtendState(textarea),
            };

            editorSession = {
                chatId,
                textarea,
                kind: 'current',
                modeKey: '',
                content: source.content || '',
                isExtend: !!source.isExtend,
                dirty: !!draft,
                loading: !currentServerUserNote || !!currentServerUserNote.pending,
            };
        } else {
            const notes = getModeNotes();
            const saved = notes[modeKey] || { content: '', isExtend: false, updatedAt: null };
            const cached = presetEditorDrafts.get(getPresetDraftKey(chatId, modeKey));
            const source = cached || saved;

            editorSession = {
                chatId,
                textarea,
                kind: 'preset',
                modeKey,
                content: source.content || '',
                isExtend: !!source.isExtend,
                dirty: !!cached?.dirty,
                loading: false,
            };
        }

        applyEditorSessionToNativeTextarea();
        renderModeSlots();
    }

    function renderModeSlots() {
        const container = document.getElementById('mun-inline-editor');
        const footer = document.getElementById('mun-inline-footer');
        if (!container || !footer) return;

        const chatId = parseChatId();
        const notes = getModeNotes();

        const activeMode = getCurrentAppliedModeForChat();
        const activeLabel = activeMode ? getModeLabel(activeMode) : '감지 대기';
        const selectedMode = editorSession?.kind === 'preset' ? editorSession.modeKey : '';
        const selectedNote = selectedMode ? notes[selectedMode] : null;
        const selectedLabel = selectedMode ? getModeLabel(selectedMode) : '';
        const content = editorSession?.content || '';

        const chips = CHAT_MODES.map(mode => {
            const note = notes[mode.key] || { content: '', updatedAt: null };
            const selected = selectedMode === mode.key;
            const active = activeMode === mode.key;
            const state = note.content ? '저장됨' : '비어 있음';

            return `
                <button
                    type="button"
                    class="mun-chip${selected ? ' is-selected' : ''}${active ? ' is-active' : ''}${note.content ? ' has-note' : ' is-empty'}"
                    data-mun-mode="${escapeHtml(mode.key)}"
                    title="${escapeHtml(mode.label)} 프리셋 · ${state}${active ? ' · 현재 모델' : ''}"
                    aria-pressed="${selected ? 'true' : 'false'}"
                ><b class="mun-note-dot" aria-hidden="true"></b><span>${escapeHtml(mode.shortLabel || mode.label)}</span>${active ? '<i aria-hidden="true"></i>' : ''}</button>
            `;
        }).join('');

        let meta;
        if (editorSession?.kind === 'preset') {
            const state = editorSession.dirty
                ? '수정 중'
                : selectedNote?.content
                    ? '저장됨'
                    : '비어 있음';
            meta = `${selectedLabel} 프리셋 · ${state} · ${countChars(content)}자${editorSession.isExtend ? ' · 확장' : ''}`;
        } else {
            meta = `실제 서버 유저노트${editorSession?.loading ? ' 불러오는 중' : ''} · ${countChars(content)}자${editorSession?.isExtend ? ' · 확장' : ''}`;
        }

        container.innerHTML = `
            <div class="mun-heading">
                <span>현재 모델</span>
                <strong>${escapeHtml(activeLabel)}</strong>
                <span class="mun-heading-sep">·</span>
                <span>${editorSession?.kind === 'preset' ? `${escapeHtml(selectedLabel)} 프리셋 편집` : '서버 유저노트 편집'}</span>
            </div>
            <div class="mun-chip-scroll" role="tablist" aria-label="유저노트 보기 선택">
                <button type="button" class="mun-chip mun-current${editorSession?.kind !== 'preset' ? ' is-selected' : ''}" data-mun-current aria-pressed="${editorSession?.kind !== 'preset'}">현재</button>
                ${chips}
            </div>
        `;

        footer.innerHTML = `
            <div class="mun-footer">
                <span id="mun-status">${escapeHtml(meta)}</span>
                <div class="mun-actions">
                    ${editorSession?.kind === 'preset' ? `
                        <button type="button" class="mun-action is-primary" data-mun-save>프리셋 저장</button>
                        <button type="button" class="mun-action" data-mun-load-current>현재값 불러오기</button>
                        <button type="button" class="mun-action" data-mun-clear>비우기</button>
                    ` : ''}
                    <button type="button" class="mun-action" data-mun-export title="현재 채팅방의 모든 프리셋 내보내기">내보내기</button>
                    <button type="button" class="mun-action" data-mun-import title="현재 채팅방에 프리셋 가져오기">가져오기</button>
                </div>
            </div>
            <div class="mun-context-note">
                ${editorSession?.kind === 'preset'
                    ? '프리셋 보기입니다. 칩 전환이나 프리셋 저장은 서버 유저노트를 변경하지 않습니다.'
                    : `Crack 저장 시 서버와 현재 모델${activeMode ? `(${escapeHtml(activeLabel)})` : ''} 프리셋이 함께 동기화됩니다.`}
            </div>
        `;

        container.querySelector('[data-mun-current]')?.addEventListener('click', () => selectEditorView('current'));
        container.querySelectorAll('[data-mun-mode]').forEach(button => {
            button.addEventListener('click', () => selectEditorView('preset', button.dataset.munMode));
        });
        footer.querySelector('[data-mun-save]')?.addEventListener('click', saveSelectedPreset);
        footer.querySelector('[data-mun-load-current]')?.addEventListener('click', loadCurrentUserNoteToSelectedPreset);
        footer.querySelector('[data-mun-clear]')?.addEventListener('click', clearSelectedPreset);
        footer.querySelector('[data-mun-export]')?.addEventListener('click', exportModeNotes);
        footer.querySelector('[data-mun-import]')?.addEventListener('click', importModeNotes);
    }

    function saveSelectedPreset() {
        const chatId = parseChatId();
        const textarea = findVisibleUserNoteTextarea();
        const modeKey = editorSession?.kind === 'preset' ? editorSession.modeKey : '';
        if (!chatId || !textarea || !modeKey) return;

        updateEditorSessionFromTextarea(textarea, true);

        const notes = getModeNotes();

        notes[modeKey] = {
            content: editorSession.content || '',
            isExtend: !!editorSession.isExtend,
            updatedAt: Date.now(),
        };

        setModeNotes(notes);
        editorSession.dirty = false;
        presetEditorDrafts.set(getPresetDraftKey(chatId, modeKey), {
            content: editorSession.content || '',
            isExtend: !!editorSession.isExtend,
            dirty: false,
        });

        renderModeSlots();

        setStatus(`${getModeLabel(modeKey)} 프리셋을 현재 채팅방에 저장했습니다.`);
        showToast(`${getModeLabel(modeKey)} 저장 완료`);
    }

    async function loadCurrentUserNoteToSelectedPreset() {
        const chatId = parseChatId();
        const textarea = findVisibleUserNoteTextarea();
        const modeKey = editorSession?.kind === 'preset' ? editorSession.modeKey : '';

        if (!chatId || !textarea || !modeKey) {
            setStatus('채팅방 페이지에서만 사용할 수 있습니다.');
            showToast('채팅방 페이지에서만 사용할 수 있습니다.');
            return;
        }

        const token = getToken();

        if (!token) {
            setStatus('인증 토큰을 찾지 못했습니다. 다시 로그인해 주세요.');
            showToast('인증 토큰을 찾지 못했습니다.');
            return;
        }

        try {
            setStatus('현재 채팅방 유저노트를 불러오는 중입니다...');

            const current = await fetchCurrentUserNote(chatId);
            currentServerUserNote = { chatId, ...current, fetchedAt: Date.now() };
            editorSession.content = current.content || '';
            editorSession.isExtend = !!current.isExtend;
            editorSession.dirty = true;
            presetEditorDrafts.set(getPresetDraftKey(chatId, modeKey), {
                content: editorSession.content,
                isExtend: editorSession.isExtend,
                dirty: true,
            });

            applyEditorSessionToNativeTextarea();
            renderModeSlots();

            setStatus(`현재 서버 유저노트를 ${getModeLabel(modeKey)} 프리셋 편집기에 불러왔습니다.`);
            showToast('현재값을 불러왔습니다. 저장하면 프리셋에만 반영됩니다.');
        } catch (err) {
            console.error('[현재 유저노트 모드 저장]', err);
            setStatus(err.message || '현재 유저노트를 불러오는 중 오류가 발생했습니다.');
            showToast('불러오기 실패');
        }
    }

    function clearSelectedPreset() {
        const chatId = parseChatId();
        const textarea = findVisibleUserNoteTextarea();
        const modeKey = editorSession?.kind === 'preset' ? editorSession.modeKey : '';
        if (!chatId || !textarea || !modeKey) return;
        if (!confirm(`${getModeLabel(modeKey)} 프리셋을 비우시겠습니까?`)) return;

        const notes = getModeNotes();

        notes[modeKey] = {
            content: '',
            isExtend: false,
            updatedAt: null,
        };

        setModeNotes(notes);
        editorSession.content = '';
        editorSession.isExtend = false;
        editorSession.dirty = false;
        presetEditorDrafts.set(getPresetDraftKey(chatId, modeKey), {
            content: '',
            isExtend: false,
            dirty: false,
        });

        applyEditorSessionToNativeTextarea();
        renderModeSlots();

        setStatus(`${getModeLabel(modeKey)} 프리셋을 비웠습니다.`);
        showToast('비우기 완료');
    }

    async function applyUserNoteByChatMode(chatId, chatMode) {
        if (!chatId || !chatMode) return;

        if (CHAT_MODES.some(mode => mode.key === chatMode)) {
            lastDetectedChatId = chatId;
            lastDetectedModeKey = chatMode;
        }

        const notes = getModeNotes();
        const note = notes[chatMode];

        if (!note) {
            setStatus(`"${chatMode}" 모드는 등록되지 않은 모드입니다.`);
            return;
        }

        if (!note.content) {
            setStatus(`${getModeLabel(chatMode)}에 저장된 프리셋이 없어 자동 적용하지 않았습니다.`);
            rememberLastAppliedNote(chatId, chatMode, '', !!note.isExtend);
            scheduleVisibleUserNoteUiSync();
            return;
        }

        const token = getToken();

        if (!token) {
            setStatus('인증 토큰을 찾지 못해 자동 적용하지 못했습니다.');
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
            setStatus(`${getModeLabel(chatMode)} 프리셋을 현재 채팅방 유저노트에 자동 적용하는 중입니다...`);

            await patchUserNote(chatId, note.content, !!note.isExtend, chatMode);

            rememberLastAppliedNote(chatId, chatMode, note.content, !!note.isExtend);
            currentServerUserNote = {
                chatId,
                content: note.content,
                isExtend: !!note.isExtend,
                fetchedAt: Date.now(),
            };

            if (editorSession?.chatId === chatId && editorSession.kind === 'current' && !editorSession.dirty) {
                editorSession.content = note.content;
                editorSession.isExtend = !!note.isExtend;
                editorSession.loading = false;
                applyEditorSessionToNativeTextarea();
            }

            renderModeSlots();
            scheduleVisibleUserNoteUiSync();

            setStatus(`${getModeLabel(chatMode)} 프리셋을 현재 채팅방 유저노트에 자동 적용했습니다.`);
            showToast(`${getModeLabel(chatMode)} 자동 적용 완료`);
        } catch (err) {
            console.error('[채팅 모드 유저노트 자동 적용]', err);
            setStatus(err.message || '채팅 모드별 유저노트 자동 적용 중 오류가 발생했습니다.');
            showToast('자동 적용 실패');
        }
    }

    function exportModeNotes() {
        const chatId = parseChatId();

        if (!chatId) {
            setStatus('채팅방 페이지에서만 내보낼 수 있습니다.');
            showToast('채팅방 페이지에서만 내보낼 수 있습니다.');
            return;
        }

        const notes = getModeNotes();

        const payload = {
            version: 1,
            exportedAt: new Date().toISOString(),
            type: 'crack_chat_room_mode_user_notes',
            sourceChatId: chatId,
            modes: CHAT_MODES,
            notes,
        };

        const text = JSON.stringify(payload, null, 2);

        navigator.clipboard.writeText(text)
            .then(() => {
                setStatus('현재 채팅방의 모드별 프리셋을 클립보드에 복사했습니다.');
                showToast('현재 채팅방 프리셋 내보내기 완료');
            })
            .catch(() => {
                prompt('클립보드 복사에 실패했습니다. 아래 내용을 직접 복사해 주세요.', text);
                setStatus('현재 채팅방의 모드별 프리셋을 내보냈습니다.');
            });
    }

    async function importModeNotes() {
        const chatId = parseChatId();

        if (!chatId) {
            setStatus('채팅방 페이지에서만 가져올 수 있습니다.');
            showToast('채팅방 페이지에서만 가져올 수 있습니다.');
            return;
        }

        let raw = '';

        try {
            raw = await navigator.clipboard.readText();
        } catch (err) {
            console.error('[모드별 유저노트 가져오기] clipboard read failed', err);
            setStatus('클립보드 내용을 읽지 못했습니다. 브라우저 권한을 확인해 주세요.');
            showToast('클립보드 읽기 실패');
            return;
        }

        if (!raw || !raw.trim()) {
            setStatus('클립보드에 가져올 데이터가 없습니다.');
            showToast('클립보드가 비어 있습니다.');
            return;
        }

        let parsed;

        try {
            parsed = JSON.parse(raw);
        } catch {
            setStatus('클립보드 내용이 올바른 JSON 형식이 아닙니다.');
            showToast('JSON 형식 오류');
            return;
        }

        const imported = parsed?.notes;

        if (!imported || typeof imported !== 'object') {
            setStatus('가져오기 데이터에 notes 객체가 없습니다.');
            showToast('가져오기 형식 오류');
            return;
        }

        const nextNotes = getModeNotes();

        CHAT_MODES.forEach(mode => {
            if (imported[mode.key] && typeof imported[mode.key] === 'object') {
                nextNotes[mode.key] = {
                    content: typeof imported[mode.key].content === 'string'
                        ? imported[mode.key].content
                        : '',
                    isExtend: !!imported[mode.key].isExtend,
                    updatedAt: imported[mode.key].updatedAt || Date.now(),
                };
            }
        });

        setModeNotes(nextNotes);

        if (editorSession?.chatId === chatId && editorSession.kind === 'preset') {
            const importedNote = nextNotes[editorSession.modeKey] || { content: '', isExtend: false };
            presetEditorDrafts.delete(getPresetDraftKey(chatId, editorSession.modeKey));
            editorSession.content = importedNote.content || '';
            editorSession.isExtend = !!importedNote.isExtend;
            editorSession.dirty = false;
            applyEditorSessionToNativeTextarea();
        }

        renderModeSlots();

        setStatus('현재 채팅방의 모드별 프리셋을 가져왔습니다.');
        showToast('현재 채팅방 프리셋 가져오기 완료');
    }

    function init() {
        buildUI();
        attachUserNoteSaveInterceptor();

        restoreLastAppliedNoteIfNeeded();

        if (!isChatPage()) {
            setStatus('채팅방 페이지에서만 유저노트 적용 기능이 동작합니다.');
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

        if (userNoteTextarea) {
            attachUserNoteDraftTracker(userNoteTextarea);
        }

        if (userNoteTextarea && userNoteTextarea !== lastSeenUserNoteTextarea) {
            lastSeenUserNoteTextarea = userNoteTextarea;
            lastSyncedUserNoteKey = '';
            scheduleVisibleUserNoteUiSync();
        }

        if (!userNoteTextarea && lastSeenUserNoteTextarea) {
            lastSeenUserNoteTextarea = null;
            lastSyncedUserNoteKey = '';
            editorSession = null;
            currentServerUserNote = null;
            currentEditorDraft = null;
            clearEditingUserNoteDraft('modal closed without save');
        }

        if (location.href !== lastUrl) {
            lastUrl = location.href;

            lastAutoAppliedModeKey = '';
            lastAutoApplyAt = 0;
            lastDetectedChatId = '';
            lastDetectedModeKey = '';
            lastSeenUserNoteTextarea = null;
            lastSyncedUserNoteKey = '';
            pendingUserNotePatchMode = null;
            editorSession = null;
            currentServerUserNote = null;
            currentEditorDraft = null;
            clearEditingUserNoteDraft('url changed');

            setTimeout(() => {
                init();
                setStatus('채팅방이 변경되어 해당 채팅방의 모드별 프리셋을 불러왔습니다.');
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
