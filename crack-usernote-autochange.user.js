// ==UserScript==
// @name         크랙 채팅모드별 유저노트 자동변경
// @namespace    http://tampermonkey.net/
// @version      1.5.2
// @description  crack.wrtn.ai 채팅방별로 채팅 모드 유저노트와 WRMC OOC를 저장하고, 채팅 모드 변경 시 자동 적용합니다.
// @match        https://crack.wrtn.ai/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    const API_BASE = 'https://crack-api.wrtn.ai/crack-gen';

    const BTN_POS_KEY_X = 'crack_mode_user_note_btn_x';
    const BTN_POS_KEY_Y = 'crack_mode_user_note_btn_y';
    const PANEL_OPEN_KEY = 'crack_mode_user_note_panel_open_v3';
    const MODE_NOTES_KEY_PREFIX = 'crack_mode_user_notes_v3';
    const LAST_APPLIED_NOTE_KEY = 'crack_last_applied_mode_user_note_v3';
    const WRMC_RESERVED_SLOT_TITLE = '🔄 모델별 OOC [AUTO]';

    const CHAT_MODES = [
        { key: 'hyperchat_4_0', label: '하이퍼챗 4.0' },
        { key: 'hyperchat_3_0', label: '하이퍼챗 3.0' },
        { key: 'hyperchat_2_0', label: '하이퍼챗 2.0' },
        { key: 'hyperchat_1_5', label: '하이퍼챗 1.5' },
        { key: 'hyperchat', label: '하이퍼챗' },
        { key: 'fablechat_1_0', label: '페이블챗 1.0' },
        { key: 'prochat_2_5', label: '프로챗 2.5' },
        { key: 'prochat_1_0', label: '프로챗 1.0' },
    ];

    let lastAutoAppliedModeKey = '';
    let lastAutoApplyAt = 0;
    let lastDetectedChatId = '';
    let lastDetectedChatMode = '';

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

    let internalPatchInProgress = false;
    let pendingUserNotePatchMode = null;

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

    function normalizeModePreset(value = {}) {
        const preset = value && typeof value === 'object' ? value : {};

        return {
            content: typeof preset.content === 'string' ? preset.content : '',
            isExtend: !!preset.isExtend,
            wrmcOocContent: typeof preset.wrmcOocContent === 'string'
                ? preset.wrmcOocContent
                : '',
            wrmcOocEnabled: !!preset.wrmcOocEnabled,
            updatedAt: preset.updatedAt || null,
        };
    }

    /**
     * WRMC 본체를 수정하지 않고, WRMC가 이미 제공하는 UI/action 경로만 이용한다.
     * 예약 제목이 정확히 일치하는 기타·OOC 슬롯 하나만 소유하며, 선택자가 달라지면
     * 다른 슬롯을 추측하지 않고 적용을 중단한다.
     */
    const WrmcAdapter = (() => {
        const RUNTIME_ATTR = 'data-wish-rp-runtime';
        const ROOT_SELECTOR = '#wish-rp-root';
        const PANEL_SELECTOR = `${ROOT_SELECTOR} .m3-overlay .m3-shell[role="dialog"]`;
        const QUICK_SELECTOR = '#wish-rp-quick';
        const MONITOR_SELECTOR = '#wish-rp-monitor .wish-mon-core';
        const EXTRA_VIEW_SELECTOR = `${ROOT_SELECTOR} [data-key="mem-extra"]`;
        const INJECTION_VIEW_SELECTOR = `${ROOT_SELECTOR} [data-key="home-injection"]`;
        const TOAST_SELECTOR = `${ROOT_SELECTOR} .wish-toast-wrap .m3-toast`;
        const VERIFIED_INJECTION_LABEL = '확인된 주입 항목';
        const SYNC_FAILED_TOAST_TEXT = '주입 재적용 대기';
        const DUPLICATE_WINDOW_MS = 2500;
        const UI_TIMEOUT_MS = 8000;
        // WRMC 저장/토글은 현재 주입(carrier) 재구성을 비동기로 끝낸다. 서버 PATCH·검증까지 기다린다.
        const SYNC_TIMEOUT_MS = 45000;
        const INJECTION_WAIT_MS = 30000;
        const INJECTION_POLL_MS = 400;

        let applyQueue = Promise.resolve();
        let lastApplyKey = '';
        let lastApplyAt = 0;

        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

        function runtimeMarker() {
            return document.documentElement?.getAttribute(RUNTIME_ATTR) || '';
        }

        function isAvailable() {
            return !!runtimeMarker();
        }

        function getUiState() {
            const root = document.querySelector(ROOT_SELECTOR);
            const activeNav = root?.querySelector(
                '[data-key="shell-layout"] nav[aria-label="주 메뉴"] button[data-act="nav"][aria-current="page"]'
            );
            const activeMemorySub = root?.querySelector(
                'button[data-act="memSub"][aria-selected="true"]'
            );

            return {
                runtime: runtimeMarker(),
                panelOpen: !!document.querySelector(PANEL_SELECTOR),
                quickOpen: !!document.querySelector(QUICK_SELECTOR),
                activeNav: activeNav?.dataset.arg || '',
                activeMemorySub: activeMemorySub?.dataset.arg || '',
            };
        }

        function assertChat(chatId, stage) {
            const currentChatId = parseChatId();
            if (!currentChatId || String(currentChatId) !== String(chatId)) {
                throw new Error(`WRMC OOC 적용 중 채팅방이 바뀌어 ${stage}를 중단했습니다.`);
            }
        }

        async function waitFor(getValue, description, timeout = UI_TIMEOUT_MS) {
            const startedAt = Date.now();

            while (Date.now() - startedAt < timeout) {
                const value = getValue();
                if (value) return value;
                await delay(50);
            }

            throw new Error(`WRMC UI 호환 실패: ${description}을(를) 확인하지 못했습니다.`);
        }

        function requireUnique(root, selector, description) {
            const matches = [...root.querySelectorAll(selector)];
            if (matches.length !== 1) {
                throw new Error(`WRMC UI 호환 실패: ${description} 요소가 ${matches.length}개입니다.`);
            }
            return matches[0];
        }

        function click(element, description) {
            if (!element || element.nodeType !== 1 || typeof element.click !== 'function' || element.disabled) {
                throw new Error(`WRMC UI 호환 실패: ${description}을(를) 실행할 수 없습니다.`);
            }
            element.click();
        }

        function setNativeValue(element, value) {
            const view = element.ownerDocument?.defaultView || window;
            const prototype = element.tagName === 'TEXTAREA'
                ? view.HTMLTextAreaElement?.prototype
                : view.HTMLInputElement?.prototype;
            const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
            const EventConstructor = view.Event || Event;

            if (!setter) {
                throw new Error('WRMC UI 호환 실패: 입력값 setter를 확인하지 못했습니다.');
            }

            setter.call(element, String(value ?? ''));
            element.dispatchEvent(new EventConstructor('input', { bubbles: true, composed: true }));
            element.dispatchEvent(new EventConstructor('change', { bubbles: true, composed: true }));
        }

        async function openExtraView(chatId) {
            assertChat(chatId, 'WRMC 열기 전');

            if (!document.querySelector(PANEL_SELECTOR)) {
                let quick = document.querySelector(QUICK_SELECTOR);

                if (!quick) {
                    const monitor = await waitFor(
                        () => document.querySelector(MONITOR_SELECTOR),
                        '상태 모니터'
                    );
                    click(monitor, 'WRMC 빠른 패널 열기');
                    quick = await waitFor(
                        () => document.querySelector(QUICK_SELECTOR),
                        '빠른 패널'
                    );
                }

                const fullButton = requireUnique(
                    quick,
                    'button[data-act="quickFull"]',
                    '전체 설정 버튼'
                );
                click(fullButton, 'WRMC 전체 설정 열기');
                await waitFor(() => document.querySelector(PANEL_SELECTOR), '전체 패널');
            }

            assertChat(chatId, 'WRMC 기억 화면 전환 전');
            const root = document.querySelector(ROOT_SELECTOR);
            if (!root) throw new Error('WRMC UI 호환 실패: 루트 요소가 없습니다.');

            if (root.querySelector('.wish-dlg-layer > .m3-dialog:not(.m3-leaving)')) {
                throw new Error('WRMC OOC 자동 적용 보류: WRMC 편집창이 열려 있습니다.');
            }

            const memoryButton = requireUnique(
                root,
                '[data-key="shell-layout"] nav[aria-label="주 메뉴"] button[data-act="nav"][data-arg="memory"]',
                '기억 탭 버튼'
            );
            click(memoryButton, 'WRMC 기억 탭 열기');

            const extraButton = await waitFor(() => {
                const buttons = [...root.querySelectorAll('button[data-act="memSub"][data-arg="extra"]')];
                return buttons.length === 1 ? buttons[0] : null;
            }, '기타·OOC 탭 버튼');
            click(extraButton, 'WRMC 기타·OOC 탭 열기');

            return waitFor(() => document.querySelector(EXTRA_VIEW_SELECTOR), '기타·OOC 화면');
        }

        function findModelOocSlot(extraView) {
            const cards = [...extraView.querySelectorAll('details.m3-card')].filter(card => {
                const title = card.querySelector(':scope > summary .m3-t > b');
                return title?.textContent === WRMC_RESERVED_SLOT_TITLE;
            });

            if (cards.length > 1) {
                throw new Error('WRMC OOC 적용 중단: 예약 슬롯이 여러 개입니다.');
            }
            if (!cards.length) return null;

            const card = cards[0];
            const editButton = requireUnique(card, 'button[data-act="xEdit"][data-arg]', '예약 슬롯 편집 버튼');
            const slotId = editButton.dataset.arg || '';
            const enableButton = [...card.querySelectorAll('button[data-act="flip"][data-arg]')]
                .find(button => button.dataset.arg === `extra.enabled:${slotId}`);

            if (!slotId || !enableButton) {
                throw new Error('WRMC UI 호환 실패: 예약 슬롯 제어를 확인하지 못했습니다.');
            }

            return {
                card,
                editButton,
                enableButton,
                slotId,
                content: card.querySelector(':scope > .m3-cardbody > p')?.textContent ?? '',
            };
        }

        async function waitForSlotEditor() {
            return waitFor(() => {
                const dialogs = [...document.querySelectorAll(`${ROOT_SELECTOR} .wish-dlg-layer > .m3-dialog`)]
                    .filter(dialog => (
                        dialog.querySelector('input[data-bind$=".title"]') &&
                        dialog.querySelector('textarea[data-bind$=".content"]') &&
                        dialog.querySelector('button[data-act="eSave"][data-arg]')
                    ));
                return dialogs.length === 1 ? dialogs[0] : null;
            }, '기타·OOC 편집창');
        }

        async function ensureModelOocSlot(extraView, chatId) {
            const existing = findModelOocSlot(extraView);
            if (existing) return { slot: existing, editor: null, created: false };

            assertChat(chatId, '예약 슬롯 생성 전');
            const addButton = requireUnique(extraView, 'button[data-act="xNew"]', '기타·OOC 추가 버튼');
            click(addButton, 'WRMC 예약 슬롯 생성');
            const editor = await waitForSlotEditor();
            assertChat(chatId, '예약 슬롯 편집 전');
            return { slot: null, editor, created: true };
        }

        async function setSlotContent(slotState, content, chatId, force) {
            if (slotState.slot && !force && slotState.slot.content === content) return slotState.slot;

            let editor = slotState.editor;
            if (!editor) {
                assertChat(chatId, '예약 슬롯 편집 전');
                click(slotState.slot.editButton, 'WRMC 예약 슬롯 편집');
                editor = await waitForSlotEditor();
            }

            const titleInput = requireUnique(editor, 'input[data-bind$=".title"]', '예약 슬롯 제목 입력');
            const contentInput = requireUnique(editor, 'textarea[data-bind$=".content"]', '예약 슬롯 내용 입력');
            const saveButton = requireUnique(editor, 'button[data-act="eSave"][data-arg]', '예약 슬롯 저장 버튼');

            setNativeValue(titleInput, WRMC_RESERVED_SLOT_TITLE);
            setNativeValue(contentInput, content);
            assertChat(chatId, '예약 슬롯 저장 전');
            click(saveButton, 'WRMC 예약 슬롯 저장');
            // WRMC 편집창은 저장 + 현재 주입 동기화(WUISyncMemoryEdit)가 끝난 뒤에 닫힌다.
            await waitFor(() => !editor.isConnected, '예약 슬롯 저장 완료', SYNC_TIMEOUT_MS);

            const extraView = await waitFor(
                () => document.querySelector(EXTRA_VIEW_SELECTOR),
                '저장 후 기타·OOC 화면'
            );
            const slot = findModelOocSlot(extraView);
            if (!slot) throw new Error('WRMC OOC 저장 후 예약 슬롯을 확인하지 못했습니다.');
            return slot;
        }

        async function setSlotEnabled(slot, enabled, chatId) {
            const current = slot.enableButton.getAttribute('aria-pressed') === 'true';
            if (current === enabled) return false;

            assertChat(chatId, '예약 슬롯 활성 상태 저장 전');
            click(slot.enableButton, 'WRMC 예약 슬롯 활성 상태 변경');
            await waitFor(() => {
                const view = document.querySelector(EXTRA_VIEW_SELECTOR);
                const refreshed = view ? findModelOocSlot(view) : null;
                return refreshed?.enableButton.getAttribute('aria-pressed') === String(enabled);
            }, '예약 슬롯 활성 상태 반영');
            await delay(350);
            assertChat(chatId, '예약 슬롯 활성 상태 저장 후');
            return true;
        }

        function isInjectionActive() {
            const root = document.querySelector(ROOT_SELECTOR);
            return !!root?.querySelector('.m3-inject[data-act="release"]');
        }

        async function openInjectionView(chatId) {
            assertChat(chatId, '현재 주입 확인 전');
            const root = document.querySelector(ROOT_SELECTOR);
            if (!root) throw new Error('WRMC UI 호환 실패: 루트 요소가 없습니다.');

            const checkButton = requireUnique(
                root,
                '[data-key="shell-layout"] nav[aria-label="주 메뉴"] button[data-act="nav"][data-arg="check"]',
                '주입확인 탭 버튼'
            );
            click(checkButton, 'WRMC 주입확인 탭 열기');
            return waitFor(() => document.querySelector(INJECTION_VIEW_SELECTOR), '주입확인 화면');
        }

        function findInjectionRows(injectionView) {
            return [...injectionView.querySelectorAll('.m3-irow')].filter(row => (
                row.querySelector('.m3-t > b')?.textContent === WRMC_RESERVED_SLOT_TITLE
            ));
        }

        function readInjectionPanel(injectionView) {
            const rows = findInjectionRows(injectionView);
            return {
                rows,
                activeRows: rows.filter(row => !row.classList.contains('is-off')),
                totalRows: injectionView.querySelectorAll('.m3-irow').length,
                // WRMC는 현재 구성이 저장된 carrier와 같고 서버 검증까지 끝났을 때만 이 제목을 쓴다.
                verified: injectionView.querySelector(':scope > .m3-row > b')?.textContent === VERIFIED_INJECTION_LABEL,
            };
        }

        // WRMC contextItemSection()/safeForHtmlComment()와 같은 규칙으로 기대 섹션을 만든다.
        const ZERO_WIDTH_SPACE = String.fromCharCode(0x200B);
        function commentSafe(text) {
            return String(text || '').replace(/<!--/g, '<' + ZERO_WIDTH_SPACE + '!--').replace(/-->/g, '--' + ZERO_WIDTH_SPACE + '>');
        }

        function reservedSectionHeading() {
            return `### ${commentSafe(WRMC_RESERVED_SLOT_TITLE)}\n`;
        }

        function expectedReservedSection(content) {
            return reservedSectionHeading() + commentSafe(String(content || '').trim());
        }

        function previewCardTitle(card) {
            const title = card.querySelector(':scope > summary .m3-t > b');
            if (!title) return '';
            const prefix = title.querySelector('.m3-pvn')?.textContent || '';
            const text = title.textContent || '';
            return prefix && text.startsWith(prefix) ? text.slice(prefix.length) : text;
        }

        function openDialogs() {
            return [...document.querySelectorAll(`${ROOT_SELECTOR} .wish-dlg-layer > .m3-dialog:not(.m3-leaving)`)];
        }

        async function closeDialog(dialog, description) {
            if (!dialog.isConnected) return;
            // WRMC 시트는 헤더 아이콘과 푸터에 같은 closeDlg 버튼을 둔다.
            const dialogId = dialog.dataset?.dlg || '';
            const closeButton = [...dialog.querySelectorAll('button[data-act="closeDlg"][data-arg]')]
                .find(button => !dialogId || button.dataset.arg === dialogId);
            click(closeButton, `WRMC ${description} 닫기`);
            await waitFor(() => !dialog.isConnected, `${description} 닫힘`);
        }

        /**
         * WRMC 주입 미리보기(카드별 원문)와 그 안의 [전체 원문] 뷰어를 공식 UI로 열어 읽는다.
         * 전체 원문은 WRMC가 실제 carrier에 넣는 context block과 같은 formatter 결과다.
         */
        async function readInjectionPreview(chatId) {
            assertChat(chatId, '현재 주입 원문 확인 전');
            const root = document.querySelector(ROOT_SELECTOR);
            const previewButton = requireUnique(root, 'button[data-act="preview"]', '주입 미리보기 버튼');
            click(previewButton, 'WRMC 주입 미리보기 열기');

            const dialog = await waitFor(
                () => openDialogs().find(item => item.querySelector('button[data-act="viewer"]')) || null,
                '주입 미리보기'
            );

            try {
                const cards = [...dialog.querySelectorAll('details.m3-card[data-key^="k-pv-"]')]
                    .filter(card => previewCardTitle(card) === WRMC_RESERVED_SLOT_TITLE);
                if (cards.length > 1) {
                    throw new Error('WRMC OOC 적용 중단: 현재 주입에 예약 슬롯이 여러 개입니다.');
                }
                const cardContent = cards[0]?.querySelector(':scope > .m3-cardbody pre.m3-block')?.textContent ?? null;

                click(requireUnique(dialog, 'button[data-act="viewer"]', '전체 원문 버튼'), 'WRMC 주입 전체 원문 열기');
                const viewer = await waitFor(
                    () => openDialogs().find(item => item !== dialog && item.querySelector('pre.m3-block.tall')) || null,
                    '주입 전체 원문'
                );
                try {
                    const fullText = viewer.querySelector('pre.m3-block.tall')?.textContent ?? '';
                    return { cardContent, fullText };
                } finally {
                    await closeDialog(viewer, '주입 전체 원문');
                }
            } finally {
                await closeDialog(dialog, '주입 미리보기');
            }
        }

        function newSyncFailureToast(knownToasts) {
            return [...document.querySelectorAll(TOAST_SELECTOR)].some(toast => (
                !knownToasts.has(toast) && String(toast.textContent || '').includes(SYNC_FAILED_TOAST_TEXT)
            ));
        }

        function judgeInjection(preview, content, enabled) {
            if (!enabled) return !preview.fullText.includes(reservedSectionHeading());
            return preview.cardContent === String(content || '').trim() &&
                preview.fullText.includes(expectedReservedSection(content));
        }

        /**
         * WRMC 토글/저장은 화면 상태를 먼저 바꾸고 현재 주입 재구성(reconcileStableCarrier)은
         * 서버 PATCH·검증 뒤에 끝난다. 주입확인 화면을 다시 그리며 그 완료를 기다린 뒤,
         * 주입 미리보기 카드와 전체 원문에 예약 슬롯 제목·본문이 실제로 있는지 확인한다.
         */
        async function verifyCurrentInjection(content, enabled, chatId, knownToasts = new Set()) {
            const inactive = { active: false, reflected: true, quickExcluded: false, carrierVerified: false };
            if (!isInjectionActive()) return inactive;

            const deadline = Date.now() + INJECTION_WAIT_MS;
            while (true) {
                assertChat(chatId, '현재 주입 반영 확인 중');
                if (!isInjectionActive()) return inactive;

                // 주입확인 탭을 다시 누르면 WRMC가 최신 pending으로 화면을 다시 그린다.
                const panel = readInjectionPanel(await openInjectionView(chatId));
                if (
                    enabled &&
                    !panel.activeRows.length &&
                    panel.rows.length === 1 &&
                    panel.rows[0].classList.contains('why-me')
                ) {
                    return { active: true, reflected: true, quickExcluded: true, carrierVerified: panel.verified };
                }

                const rowsReady = enabled
                    ? panel.activeRows.length === 1 && panel.rows.length === 1
                    : !panel.activeRows.length;
                const settled = rowsReady && (panel.verified || (!enabled && !panel.totalRows));
                const timedOut = Date.now() >= deadline;
                const syncFailed = newSyncFailureToast(knownToasts);

                if (settled || timedOut || syncFailed) {
                    if (!rowsReady) {
                        return { active: true, reflected: false, quickExcluded: false, carrierVerified: false };
                    }
                    const preview = await readInjectionPreview(chatId);
                    return {
                        active: true,
                        reflected: judgeInjection(preview, content, enabled),
                        quickExcluded: false,
                        carrierVerified: settled,
                    };
                }
                await delay(INJECTION_POLL_MS);
            }
        }

        async function refreshCurrentInjectionViaSlotSave(content, chatId) {
            const extraView = await openExtraView(chatId);
            const slot = findModelOocSlot(extraView);
            if (!slot) throw new Error('WRMC 현재 주입 갱신 전 예약 슬롯을 확인하지 못했습니다.');
            return setSlotContent({ slot, editor: null, created: false }, content, chatId, true);
        }

        async function restoreUiState(initialState) {
            const root = document.querySelector(ROOT_SELECTOR);

            if (initialState.panelOpen && document.querySelector(PANEL_SELECTOR) && root) {
                if (initialState.activeNav === 'memory') {
                    const memoryButton = requireUnique(
                        root,
                        '[data-key="shell-layout"] nav[aria-label="주 메뉴"] button[data-act="nav"][data-arg="memory"]',
                        '기억 탭 복원 버튼'
                    );
                    click(memoryButton, 'WRMC 기억 탭 복원');
                    if (initialState.activeMemorySub) {
                        const subButton = await waitFor(() => {
                            const buttons = [...root.querySelectorAll(
                                `button[data-act="memSub"][data-arg="${initialState.activeMemorySub}"]`
                            )];
                            return buttons.length === 1 ? buttons[0] : null;
                        }, '기억 하위 탭 복원 버튼');
                        click(subButton, 'WRMC 기억 하위 탭 복원');
                    }
                } else if (initialState.activeNav && initialState.activeNav !== 'memory') {
                    const navButton = requireUnique(
                        root,
                        `[data-key="shell-layout"] nav[aria-label="주 메뉴"] button[data-act="nav"][data-arg="${initialState.activeNav}"]`,
                        '기존 탭 복원 버튼'
                    );
                    click(navButton, 'WRMC 기존 탭 복원');
                }
            }

            if (!initialState.panelOpen && document.querySelector(PANEL_SELECTOR) && root) {
                const closeButton = requireUnique(root, 'button[data-act="closePanel"]', '전체 패널 닫기 버튼');
                click(closeButton, 'WRMC 전체 패널 닫기');
                await waitFor(() => !document.querySelector(PANEL_SELECTOR), '전체 패널 닫힘');
            }

            if (initialState.quickOpen && !document.querySelector(QUICK_SELECTOR)) {
                const monitor = document.querySelector(MONITOR_SELECTOR);
                if (monitor) {
                    click(monitor, 'WRMC 빠른 패널 복원');
                    await waitFor(() => document.querySelector(QUICK_SELECTOR), '빠른 패널 복원');
                }
            } else if (!initialState.quickOpen && document.querySelector(QUICK_SELECTOR)) {
                const quick = document.querySelector(QUICK_SELECTOR);
                const closeButton = quick && requireUnique(quick, 'button[data-act="quickClose"]', '빠른 패널 닫기 버튼');
                if (closeButton) click(closeButton, 'WRMC 빠른 패널 닫기');
            }
        }

        async function applyInternal(request) {
            if (!isAvailable()) return { applied: false, reason: 'not-installed' };

            const initialState = getUiState();
            const content = String(request.content || '');
            const enabled = !!request.enabled && !!content.trim();

            try {
                assertChat(request.chatId, 'WRMC OOC 적용 직전');
                const extraView = await openExtraView(request.chatId);
                let slotState = await ensureModelOocSlot(extraView, request.chatId);

                if (slotState.created || enabled) {
                    slotState = {
                        slot: await setSlotContent(slotState, content, request.chatId, !!request.force),
                        editor: null,
                        created: slotState.created,
                    };
                }

                assertChat(request.chatId, '예약 슬롯 최종 적용 전');
                // 토글의 비동기 주입 재구성이 실패하면 WRMC가 새 경고 토스트를 띄운다.
                let knownToasts = new Set(document.querySelectorAll(TOAST_SELECTOR));
                await setSlotEnabled(slotState.slot, enabled, request.chatId);

                let injection = await verifyCurrentInjection(content, enabled, request.chatId, knownToasts);
                if (injection.active && !injection.reflected) {
                    // WRMC 동기화가 보류·실패한 경우에만 같은 슬롯을 공식 편집창으로 다시 저장해
                    // WUISyncMemoryEdit → reconcileStableCarrier를 한 번 더 실행시킨다.
                    knownToasts = new Set(document.querySelectorAll(TOAST_SELECTOR));
                    const refreshContent = enabled ? content : slotState.slot.content;
                    await refreshCurrentInjectionViaSlotSave(refreshContent, request.chatId);
                    injection = await verifyCurrentInjection(content, enabled, request.chatId, knownToasts);
                }
                if (injection.active && !injection.reflected) {
                    throw new Error(enabled
                        ? 'WRMC OOC 저장은 완료했지만 주입확인에 예약 OOC 제목·본문이 나타나지 않았습니다.'
                        : 'WRMC OOC 주입 OFF는 저장했지만 주입확인에서 예약 OOC가 제거되지 않았습니다.');
                }

                const message = !injection.active
                    ? (enabled
                        ? '[모델별 프리셋/WRMC] OOC 저장 완료 · 다음 주입 시작 시 포함'
                        : '[모델별 프리셋/WRMC] OOC 저장 완료 · 주입 OFF')
                    : injection.quickExcluded
                        ? '[모델별 프리셋/WRMC] OOC 저장 완료 · 현재 주입의 사용자 제외 유지'
                        : injection.carrierVerified
                            ? '[모델별 프리셋/WRMC] 모델별 OOC 적용 및 현재 주입 반영 완료'
                            : '[모델별 프리셋/WRMC] 모델별 OOC 주입확인 반영 · WRMC 서버 저장 확인 대기';
                console.log(message, {
                    chatId: request.chatId,
                    mode: request.mode,
                    enabled,
                    length: countChars(content),
                    runtime: initialState.runtime,
                });
                return {
                    applied: true,
                    enabled,
                    injectionActive: injection.active,
                    injectionReflected: injection.reflected,
                    carrierVerified: injection.carrierVerified,
                    quickExcluded: injection.quickExcluded,
                };
            } finally {
                try {
                    await restoreUiState(initialState);
                } catch (restoreError) {
                    console.warn('[모델별 프리셋/WRMC] UI 상태 복원 실패', restoreError);
                }
            }
        }

        function applyPreset(request) {
            const normalized = {
                chatId: String(request?.chatId || ''),
                mode: String(request?.mode || ''),
                content: String(request?.content || ''),
                enabled: !!request?.enabled,
                force: !!request?.force,
            };

            if (!normalized.chatId || !normalized.mode) return Promise.resolve({ applied: false, reason: 'invalid' });

            const applyKey = JSON.stringify([
                normalized.chatId,
                normalized.mode,
                normalized.content,
                normalized.enabled,
            ]);
            const now = Date.now();

            if (!normalized.force && applyKey === lastApplyKey && now - lastApplyAt < DUPLICATE_WINDOW_MS) {
                return Promise.resolve({ applied: false, reason: 'duplicate' });
            }

            lastApplyKey = applyKey;
            lastApplyAt = now;
            const task = applyQueue.catch(() => {}).then(() => applyInternal(normalized));
            applyQueue = task;
            return task;
        }

        return {
            isAvailable,
            getUiState,
            findModelOocSlot,
            ensureModelOocSlot,
            setSlotContent,
            setSlotEnabled,
            verifyCurrentInjection,
            applyPreset,
        };
    })();

    function getModePreset(notes, modeKey) {
        if (!CHAT_MODES.some(mode => mode.key === modeKey)) return null;
        return normalizeModePreset(notes?.[modeKey]);
    }

    function getModeNotes() {
        const saved = GM_getValue(getModeNotesKey(), null);
        const notes = saved && typeof saved === 'object' ? { ...saved } : {};

        CHAT_MODES.forEach(mode => {
            notes[mode.key] = normalizeModePreset(saved?.[mode.key]);
        });

        GM_setValue(getModeNotesKey(), notes);
        return notes;
    }

    function setModeNotes(notes) {
        GM_setValue(getModeNotesKey(), notes);
    }

    function getPanelOpen() {
        return GM_getValue(PANEL_OPEN_KEY, false);
    }

    function setPanelOpen(value) {
        GM_setValue(PANEL_OPEN_KEY, !!value);
    }

    function escapeHtml(str) {
        return String(str ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function formatTime(ts) {
        if (!ts) return '저장되지 않았습니다.';

        try {
            return new Date(ts).toLocaleString();
        } catch {
            return '시간 표시 중 오류가 발생했습니다.';
        }
    }

    function countChars(text) {
        return [...String(text || '')].length;
    }

    function previewText(text, maxLen = 120) {
        if (!text) return '(비어 있습니다)';

        const normalized = text.replace(/\s+/g, ' ').trim();

        return countChars(normalized) > maxLen
            ? [...normalized].slice(0, maxLen).join('') + '…'
            : normalized;
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

        if (lastDetectedChatId === chatId && lastDetectedChatMode) {
            return lastDetectedChatMode;
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

    function rememberDetectedChatMode(chatId, modeKey) {
        lastDetectedChatId = chatId || '';
        lastDetectedChatMode = modeKey || '';
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

    function captureEditingUserNoteDraft(textarea) {
        if (!textarea || suppressDraftCapture) return;

        const chatId = parseChatId();
        if (!chatId) return;

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
            ...normalizeModePreset(notes[draft.modeKey]),
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

            clearEditingUserNoteDraft('committed');
            return true;
        } catch (err) {
            console.error('[채팅모드별 유저노트 자동변경] draft 서버 저장 실패', err);
            setStatus('프리셋에는 반영했지만 서버 저장 중 오류가 발생했습니다.');
            showToast('서버 저장 실패');
            return false;
        }
    }

    function attachUserNoteDraftTracker(textarea) {
        if (!textarea || textarea.dataset.modeUserNoteDraftTrackerAttached === '1') return;

        textarea.dataset.modeUserNoteDraftTrackerAttached = '1';

        const capture = () => {
            if (suppressDraftCapture) return;
            captureEditingUserNoteDraft(textarea);
        };

        textarea.addEventListener('input', capture);
        textarea.addEventListener('change', capture);
        textarea.addEventListener('keyup', capture);
        textarea.addEventListener('paste', () => {
            setTimeout(capture, 0);
        });
        textarea.addEventListener('compositionend', capture);
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

        const handleSave = event => {
            const button = event.target?.closest?.('button');
            if (!button) return;

            const textarea = findVisibleUserNoteTextarea();
            if (!textarea) return;

            const dialog = textarea.closest('[role="dialog"]');

            if (dialog && !dialog.contains(button)) return;

            if (!isLikelyUserNoteSaveButton(button)) return;

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

        if (lastAppliedUserNoteChatId === chatId && lastAppliedUserNoteMode) {
            const immediateContent = lastAppliedUserNoteContent || '';
            const immediateIsExtend = !!lastAppliedUserNoteIsExtend;

            const immediateKey = `${chatId}:immediate:${lastAppliedUserNoteMode}:${countChars(immediateContent)}:${immediateIsExtend}`;

            if (lastSyncedUserNoteKey !== immediateKey || textarea.value !== immediateContent) {
                setDisplayTextareaValueOnly(textarea, immediateContent);
                updateUserNoteCounterUI(textarea, immediateContent, immediateIsExtend);
                updateUserNoteExtendSwitchUI(textarea, immediateIsExtend);
                syncUserNoteTextareaHeightLikeCrack(textarea);

                lastSyncedUserNoteKey = immediateKey;

                console.log('[채팅모드별 유저노트 자동변경] 유저노트 창을 마지막 적용값으로 즉시 동기화했습니다.', {
                    chatId,
                    mode: lastAppliedUserNoteMode,
                    length: countChars(immediateContent),
                    isExtend: immediateIsExtend,
                });
            }
        }

        try {
            const serverNote = await fetchCurrentUserNote(chatId);

            const content = serverNote.content || '';
            const isExtend = !!serverNote.isExtend;
            const serverKey = `${chatId}:server:${countChars(content)}:${isExtend}:${content.slice(0, 40)}`;

            if (lastSyncedUserNoteKey === serverKey && textarea.value === content) {
                return;
            }

            setDisplayTextareaValueOnly(textarea, content);
            updateUserNoteCounterUI(textarea, content, isExtend);
            updateUserNoteExtendSwitchUI(textarea, isExtend);
            syncUserNoteTextareaHeightLikeCrack(textarea);

            lastSyncedUserNoteKey = serverKey;

            console.log('[채팅모드별 유저노트 자동변경] 유저노트 창을 서버값으로 검증 동기화했습니다.', {
                chatId,
                length: countChars(content),
                isExtend,
            });
        } catch (err) {
            console.warn('[채팅모드별 유저노트 자동변경] 서버값 검증 실패', err);
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

        const modeKey =
            modeKeyOverride ||
            getPendingPatchMode(chatId, { content, isExtend }) ||
            getCurrentAppliedModeForChat();

        if (!modeKey) {
            console.log('[채팅모드별 유저노트 자동변경] 현재 적용 모드를 알 수 없어 PATCH 유저노트를 프리셋에 반영하지 않았습니다.');
            return;
        }

        const notes = getModeNotes();

        notes[modeKey] = {
            ...normalizeModePreset(notes[modeKey]),
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
        #mun-toggle-btn {
            position: fixed;
            right: 20px;
            bottom: 20px;
            z-index: 999999;
            width: 52px;
            height: 52px;
            border: none;
            border-radius: 50%;
            background: #6A3DE8;
            color: #fff;
            font-size: 22px;
            cursor: pointer;
            box-shadow: 0 4px 12px rgba(0,0,0,0.18);
            display: flex;
            align-items: center;
            justify-content: center;
            touch-action: none;
            transition: transform .15s ease, opacity .15s ease, background .15s ease;
        }

        #mun-toggle-btn:hover {
            transform: scale(1.05);
            background: #5a31cf;
        }

        #mun-toggle-btn.dragging {
            opacity: 0.85;
            transform: scale(1.08);
            transition: none;
        }

        #mun-panel {
            position: fixed;
            right: 20px;
            bottom: 82px;
            z-index: 999999;
            width: 520px;
            max-width: 94vw;
            max-height: 82vh;
            overflow-y: auto;
            background: #F7F7F5;
            border: 1px solid #C7C5BD;
            border-radius: 12px;
            box-shadow: 0 8px 22px rgba(0,0,0,0.15);
            padding: 14px;
            display: none;
            font-family: sans-serif;
        }

        #mun-panel.show {
            display: block;
        }

        #mun-panel h3 {
            font-size: 15px;
            color: #1A1918;
        }

        .mun-panel-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            margin-bottom: 10px;
        }

        .mun-panel-header h3 {
            margin: 0;
        }

        #mun-close-btn {
            border: none;
            background: transparent;
            color: #61605A;
            font-size: 22px;
            line-height: 1;
            cursor: pointer;
            padding: 4px 7px;
            border-radius: 6px;
        }

        #mun-close-btn:hover {
            background: rgba(0,0,0,0.06);
            color: #1A1918;
        }

        #mun-status {
            font-size: 12px;
            line-height: 1.5;
            min-height: 18px;
            margin-bottom: 10px;
            color: #61605A;
            word-break: break-word;
        }

        .mun-top-actions {
            display: flex;
            gap: 6px;
            margin-bottom: 10px;
            flex-wrap: wrap;
        }

        .mun-btn {
            border: none;
            border-radius: 8px;
            padding: 8px 10px;
            font-size: 12px;
            cursor: pointer;
            white-space: nowrap;
        }

        .mun-btn.primary { background: #6A3DE8; color: white; }
        .mun-btn.gray { background: #61605A; color: white; }
        .mun-btn.red { background: #C0392B; color: white; }

        .mun-mode-slot {
            border: 1px solid #D9D7CF;
            border-radius: 10px;
            background: white;
            padding: 10px;
            margin-bottom: 10px;
        }

        .mun-mode-header {
            display: flex;
            justify-content: space-between;
            gap: 8px;
            align-items: flex-start;
            margin-bottom: 8px;
        }

        .mun-mode-title {
            font-size: 13px;
            font-weight: bold;
            color: #1A1918;
            word-break: break-word;
        }

        .mun-mode-key {
            font-size: 11px;
            padding: 2px 6px;
            border-radius: 999px;
            background: #EEEAFD;
            color: #5a31cf;
            white-space: nowrap;
        }

        .mun-meta {
            font-size: 11px;
            color: #777;
            margin-bottom: 8px;
            line-height: 1.5;
        }

        .mun-preview {
            font-size: 12px;
            color: #555;
            background: #FAFAF8;
            border: 1px solid #ECEAE4;
            border-radius: 8px;
            padding: 8px;
            white-space: pre-wrap;
            word-break: break-word;
            max-height: 70px;
            overflow: hidden;
            margin-bottom: 8px;
        }

        .mun-textarea {
            width: 100%;
            min-height: 130px;
            resize: vertical;
            box-sizing: border-box;
            border: 1px solid #C7C5BD;
            border-radius: 8px;
            padding: 8px;
            font-size: 12px;
            font-family: sans-serif;
            line-height: 1.5;
            color: #1A1918;
            background: #FFFFFF;
            margin-bottom: 8px;
        }

        .mun-field-title {
            font-size: 12px;
            font-weight: bold;
            color: #444;
            margin: 10px 0 6px;
        }

        .mun-ooc-textarea {
            min-height: 100px;
        }

        .mun-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            align-items: center;
        }

        .mun-extend-label {
            font-size: 12px;
            color: #555;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            margin-right: 4px;
        }

        .mun-empty {
            font-size: 12px;
            color: #777;
            padding: 10px 4px;
        }

        #mun-toast {
            position: fixed;
            left: 50%;
            bottom: 90px;
            transform: translateX(-50%);
            z-index: 1000000;
            background: rgba(30,30,30,0.92);
            color: white;
            padding: 10px 16px;
            border-radius: 18px;
            font-size: 12px;
            font-family: sans-serif;
            opacity: 0;
            transition: opacity .25s ease;
            pointer-events: none;
            max-width: 88vw;
            text-align: center;
            word-break: break-word;
        }

        #mun-toast.show {
            opacity: 1;
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
        if (document.getElementById('mun-toggle-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'mun-toggle-btn';
        btn.textContent = '🧩';

        const panel = document.createElement('div');
        panel.id = 'mun-panel';
        panel.innerHTML = `
            <div class="mun-panel-header">
                <h3>채팅모드별 유저노트 · WRMC OOC</h3>
                <button id="mun-close-btn" type="button" aria-label="닫기">×</button>
            </div>

            <div id="mun-status">준비되었습니다.</div>

            <div class="mun-top-actions">
                <button id="mun-export-btn" class="mun-btn gray">전체 내보내기</button>
                <button id="mun-import-btn" class="mun-btn gray">전체 가져오기</button>
            </div>

            <div id="mun-slots"></div>
        `;

        const toast = document.createElement('div');
        toast.id = 'mun-toast';

        document.body.appendChild(btn);
        document.body.appendChild(panel);
        document.body.appendChild(toast);

        const savedX = GM_getValue(BTN_POS_KEY_X, null);
        const savedY = GM_getValue(BTN_POS_KEY_Y, null);

        if (savedX !== null && savedY !== null) {
            btn.style.left = `${savedX}px`;
            btn.style.top = `${savedY}px`;
            btn.style.right = 'auto';
            btn.style.bottom = 'auto';
        }

        if (getPanelOpen()) {
            panel.classList.add('show');
        }

        btn.addEventListener('click', () => {
            if (btn.dataset.dragged === '1') {
                btn.dataset.dragged = '0';
                return;
            }

            panel.classList.toggle('show');
            setPanelOpen(panel.classList.contains('show'));

            if (panel.classList.contains('show')) {
                renderModeSlots();
            }
        });

        document.getElementById('mun-close-btn')?.addEventListener('click', () => {
            panel.classList.remove('show');
            setPanelOpen(false);
        });

        document.getElementById('mun-export-btn')?.addEventListener('click', exportModeNotes);
        document.getElementById('mun-import-btn')?.addEventListener('click', importModeNotes);

        attachDrag(btn);
        renderModeSlots();
    }

    function renderModeSlots() {
        const container = document.getElementById('mun-slots');
        if (!container) return;

        const chatId = parseChatId();
        const notes = getModeNotes();

        if (!chatId) {
            container.innerHTML = `<div class="mun-empty">채팅방 페이지에서만 채팅방별 프리셋을 사용할 수 있습니다.</div>`;
            return;
        }

        container.innerHTML = CHAT_MODES.map(mode => {
            const note = normalizeModePreset(notes[mode.key]);

            return `
                <div class="mun-mode-slot" data-mode="${escapeHtml(mode.key)}">
                    <div class="mun-mode-header">
                        <div class="mun-mode-title">${escapeHtml(mode.label)}</div>
                        <div class="mun-mode-key">${escapeHtml(mode.key)}</div>
                    </div>

                    <div class="mun-meta">
                        현재 채팅방: ${escapeHtml(chatId)}
                        <br>
                        마지막 저장: ${escapeHtml(formatTime(note.updatedAt))}
                        <br>
                        확장 모드: ${note.isExtend ? '켜짐' : '꺼짐'}
                        <br>
                        WRMC 모델별 OOC: ${note.wrmcOocEnabled ? '사용' : '사용 안 함'}
                    </div>

                    <div class="mun-field-title">유저노트</div>
                    <div class="mun-preview">${escapeHtml(previewText(note.content))}</div>

                    <textarea
                        class="mun-textarea"
                        data-mode-textarea="${escapeHtml(mode.key)}"
                        placeholder="${escapeHtml(mode.label)}에서 자동 적용할 유저노트를 입력하세요."
                    >${escapeHtml(note.content)}</textarea>

                    <div class="mun-field-title">WRMC 모델별 OOC</div>
                    <textarea
                        class="mun-textarea mun-ooc-textarea"
                        data-mode-wrmc-ooc="${escapeHtml(mode.key)}"
                        placeholder="${escapeHtml(mode.label)}에서 WRMC 전용 모델별 OOC 슬롯에 적용할 내용을 입력하세요."
                    >${escapeHtml(note.wrmcOocContent)}</textarea>

                    <div class="mun-actions">
                        <label class="mun-extend-label">
                            <input
                                type="checkbox"
                                data-mode-extend="${escapeHtml(mode.key)}"
                                ${note.isExtend ? 'checked' : ''}
                            >
                            확장 모드
                        </label>

                        <label class="mun-extend-label">
                            <input
                                type="checkbox"
                                data-mode-wrmc-enabled="${escapeHtml(mode.key)}"
                                ${note.wrmcOocEnabled ? 'checked' : ''}
                            >
                            WRMC OOC 사용
                        </label>

                        <button class="mun-btn primary" data-action-save="${escapeHtml(mode.key)}">저장</button>
                        <button class="mun-btn gray" data-action-load="${escapeHtml(mode.key)}">현재 유저노트 불러오기</button>
                        <button class="mun-btn red" data-action-clear="${escapeHtml(mode.key)}">비우기</button>
                    </div>
                </div>
            `;
        }).join('');

        CHAT_MODES.forEach(mode => {
            container.querySelector(`[data-action-save="${CSS.escape(mode.key)}"]`)?.addEventListener('click', () => {
                saveModeNote(mode.key);
            });

            container.querySelector(`[data-action-load="${CSS.escape(mode.key)}"]`)?.addEventListener('click', () => {
                loadCurrentUserNoteToMode(mode.key);
            });

            container.querySelector(`[data-action-clear="${CSS.escape(mode.key)}"]`)?.addEventListener('click', () => {
                clearModeNote(mode.key);
            });
        });
    }

    async function saveModeNote(modeKey) {
        const textarea = document.querySelector(`[data-mode-textarea="${CSS.escape(modeKey)}"]`);
        const extendInput = document.querySelector(`[data-mode-extend="${CSS.escape(modeKey)}"]`);
        const wrmcOocTextarea = document.querySelector(`[data-mode-wrmc-ooc="${CSS.escape(modeKey)}"]`);
        const wrmcOocEnabledInput = document.querySelector(`[data-mode-wrmc-enabled="${CSS.escape(modeKey)}"]`);

        if (!textarea) return;

        const notes = getModeNotes();

        notes[modeKey] = {
            content: textarea.value || '',
            isExtend: !!extendInput?.checked,
            wrmcOocContent: wrmcOocTextarea?.value || '',
            wrmcOocEnabled: !!wrmcOocEnabledInput?.checked,
            updatedAt: Date.now(),
        };

        setModeNotes(notes);

        const currentMode = getCurrentAppliedModeForChat();
        const chatId = parseChatId();
        let applyResult = null;

        if (chatId && currentMode === modeKey) {
            applyResult = await applyPresetByChatMode(chatId, modeKey, { force: true, source: 'manual-save' });
        }

        renderModeSlots();

        if (applyResult?.userNoteError || applyResult?.wrmcError) {
            const failed = [
                applyResult.userNoteError ? '유저노트' : '',
                applyResult.wrmcError ? 'WRMC OOC' : '',
            ].filter(Boolean).join('·');
            setStatus(`${getModeLabel(modeKey)} 프리셋은 저장했지만 ${failed} 즉시 적용은 실패했습니다.`);
            showToast(`${getModeLabel(modeKey)} 저장 · ${failed} 적용 실패`);
        } else {
            setStatus(`${getModeLabel(modeKey)} 프리셋을 현재 채팅방에 저장했습니다.`);
            showToast(`${getModeLabel(modeKey)} 저장 완료`);
        }
    }

    async function loadCurrentUserNoteToMode(modeKey) {
        const chatId = parseChatId();

        if (!chatId) {
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
            const notes = getModeNotes();

            notes[modeKey] = {
                ...normalizeModePreset(notes[modeKey]),
                content: current.content || '',
                isExtend: !!current.isExtend,
                updatedAt: Date.now(),
            };

            setModeNotes(notes);

            const currentMode = getCurrentAppliedModeForChat();

            if (currentMode === modeKey) {
                rememberLastAppliedNote(chatId, modeKey, current.content || '', !!current.isExtend);
            }

            renderModeSlots();

            setStatus(`현재 유저노트를 ${getModeLabel(modeKey)} 프리셋에 저장했습니다.`);
            showToast(`${getModeLabel(modeKey)}에 불러오기 완료`);
        } catch (err) {
            console.error('[현재 유저노트 모드 저장]', err);
            setStatus(err.message || '현재 유저노트를 불러오는 중 오류가 발생했습니다.');
            showToast('불러오기 실패');
        }
    }

    async function clearModeNote(modeKey) {
        if (!confirm(`${getModeLabel(modeKey)} 프리셋을 비우시겠습니까?`)) return;

        const notes = getModeNotes();

        notes[modeKey] = {
            content: '',
            isExtend: false,
            wrmcOocContent: '',
            wrmcOocEnabled: false,
            updatedAt: null,
        };

        setModeNotes(notes);

        const currentMode = getCurrentAppliedModeForChat();
        const chatId = parseChatId();
        let wrmcApplyError = null;

        if (chatId && currentMode === modeKey) {
            rememberLastAppliedNote(chatId, modeKey, '', false);
            try {
                await WrmcAdapter.applyPreset({
                    chatId,
                    mode: modeKey,
                    content: '',
                    enabled: false,
                    force: true,
                });
            } catch (err) {
                console.warn('[모델별 프리셋/WRMC] OOC 비활성 적용 실패', err);
                wrmcApplyError = err;
            }
        }

        renderModeSlots();

        if (wrmcApplyError) {
            setStatus(`${getModeLabel(modeKey)} 프리셋을 비웠지만 WRMC OOC 비활성은 실패했습니다: ${wrmcApplyError.message || '현재 WRMC UI 구조를 인식하지 못했습니다.'}`);
            showToast('프리셋 비움 · WRMC OOC 적용 실패');
        } else {
            setStatus(`${getModeLabel(modeKey)} 프리셋을 비웠습니다.`);
            showToast('비우기 완료');
        }
    }

    async function applyUserNotePreset(chatId, chatMode, preset, options = {}) {
        if (!preset.content) {
            setStatus(`${getModeLabel(chatMode)}에 저장된 유저노트가 없어 유저노트 자동 적용은 생략했습니다.`);
            rememberLastAppliedNote(chatId, chatMode, '', !!preset.isExtend);
            scheduleVisibleUserNoteUiSync();
            return false;
        }

        const token = getToken();

        if (!token) {
            throw new Error('인증 토큰을 찾지 못해 유저노트를 자동 적용하지 못했습니다.');
        }

        const applyKey = JSON.stringify([
            chatId,
            chatMode,
            preset.content,
            !!preset.isExtend,
        ]);
        const now = Date.now();

        if (
            !options.force &&
            lastAutoAppliedModeKey === applyKey &&
            now - lastAutoApplyAt < 2500
        ) {
            return false;
        }

        lastAutoAppliedModeKey = applyKey;
        lastAutoApplyAt = now;

        setStatus(`${getModeLabel(chatMode)} 프리셋을 현재 채팅방 유저노트에 자동 적용하는 중입니다...`);
        await patchUserNote(chatId, preset.content, !!preset.isExtend, chatMode);

        rememberLastAppliedNote(chatId, chatMode, preset.content, !!preset.isExtend);
        scheduleVisibleUserNoteUiSync();

        setStatus(`${getModeLabel(chatMode)} 프리셋을 현재 채팅방 유저노트에 자동 적용했습니다.`);
        showToast(`${getModeLabel(chatMode)} 자동 적용 완료`);
        return true;
    }

    async function applyPresetByChatMode(chatId, chatMode, options = {}) {
        if (!chatId || !chatMode) return;

        const currentChatId = parseChatId();
        if (currentChatId && String(currentChatId) !== String(chatId)) {
            console.log('[모델별 프리셋] 채팅방이 바뀌어 프리셋 적용을 생략했습니다.', {
                eventChatId: chatId,
                currentChatId,
                chatMode,
            });
            return;
        }

        rememberDetectedChatMode(String(chatId), String(chatMode));

        const preset = getModePreset(getModeNotes(), chatMode);
        if (!preset) {
            console.warn(`[모델별 프리셋] 알 수 없는 chat_mode 감지: ${chatMode}`);
            setStatus(`알 수 없는 chat_mode 감지: ${chatMode} (자동 적용 생략)`);
            return;
        }

        let userNoteError = null;
        let wrmcError = null;

        try {
            await applyUserNotePreset(chatId, chatMode, preset, options);
        } catch (err) {
            console.error('[모델별 프리셋/유저노트] 자동 적용 실패', err);
            setStatus(err.message || '모델별 유저노트 자동 적용 중 오류가 발생했습니다.');
            showToast('유저노트 자동 적용 실패');
            userNoteError = err;
        }

        try {
            await WrmcAdapter.applyPreset({
                chatId,
                mode: chatMode,
                content: preset.wrmcOocContent,
                enabled: preset.wrmcOocEnabled,
                force: !!options.force,
            });
        } catch (err) {
            console.warn('[모델별 프리셋/WRMC] OOC 자동 적용 실패', err);
            setStatus(`WRMC OOC 자동 적용 실패: ${err.message || '현재 WRMC UI 구조를 인식하지 못했습니다.'}`);
            wrmcError = err;
        }

        return { userNoteError, wrmcError };
    }

    async function applyUserNoteByChatMode(chatId, chatMode, options = {}) {
        return applyPresetByChatMode(chatId, chatMode, options);
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
            version: 2,
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
                    wrmcOocContent: typeof imported[mode.key].wrmcOocContent === 'string'
                        ? imported[mode.key].wrmcOocContent
                        : '',
                    wrmcOocEnabled: !!imported[mode.key].wrmcOocEnabled,
                    updatedAt: imported[mode.key].updatedAt || Date.now(),
                };
            }
        });

        setModeNotes(nextNotes);

        const currentMode = getCurrentAppliedModeForChat();

        if (currentMode && nextNotes[currentMode]) {
            rememberLastAppliedNote(
                chatId,
                currentMode,
                nextNotes[currentMode].content || '',
                !!nextNotes[currentMode].isExtend
            );
        }

        renderModeSlots();

        setStatus('현재 채팅방의 모드별 프리셋을 가져왔습니다.');
        showToast('현재 채팅방 프리셋 가져오기 완료');
    }

    function attachDrag(btn) {
        let isDragging = false;
        let hasDragged = false;
        let pressTimer = null;
        let startX = 0;
        let startY = 0;
        let initialLeft = 0;
        let initialTop = 0;

        function startDrag(e) {
            hasDragged = false;

            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;

            const rect = btn.getBoundingClientRect();

            startX = clientX;
            startY = clientY;
            initialLeft = rect.left;
            initialTop = rect.top;

            pressTimer = setTimeout(() => {
                isDragging = true;
                btn.classList.add('dragging');
            }, 320);
        }

        function moveDrag(e) {
            if (!isDragging) return;

            e.preventDefault();
            hasDragged = true;

            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;

            let newLeft = initialLeft + (clientX - startX);
            let newTop = initialTop + (clientY - startY);

            const maxX = window.innerWidth - btn.offsetWidth;
            const maxY = window.innerHeight - btn.offsetHeight;

            newLeft = Math.max(0, Math.min(newLeft, maxX));
            newTop = Math.max(0, Math.min(newTop, maxY));

            btn.style.left = `${newLeft}px`;
            btn.style.top = `${newTop}px`;
            btn.style.right = 'auto';
            btn.style.bottom = 'auto';
        }

        function endDrag() {
            clearTimeout(pressTimer);

            if (isDragging) {
                isDragging = false;
                btn.classList.remove('dragging');

                GM_setValue(BTN_POS_KEY_X, parseInt(btn.style.left, 10));
                GM_setValue(BTN_POS_KEY_Y, parseInt(btn.style.top, 10));
            }

            if (hasDragged) {
                btn.dataset.dragged = '1';

                setTimeout(() => {
                    btn.dataset.dragged = '0';
                }, 100);
            }
        }

        btn.addEventListener('touchstart', startDrag, { passive: false });
        btn.addEventListener('touchmove', moveDrag, { passive: false });
        btn.addEventListener('touchend', endDrag);

        btn.addEventListener('mousedown', startDrag);
        document.addEventListener('mousemove', moveDrag);
        document.addEventListener('mouseup', endDrag);
    }

    function init() {
        buildUI();
        attachUserNoteSaveInterceptor();

        restoreLastAppliedNoteIfNeeded();

        if (!isChatPage()) {
            setStatus('채팅방 페이지에서만 유저노트 적용 기능이 동작합니다.');
            return;
        }

        renderModeSlots();
    }

    let lastUrl = location.href;

    const observer = new MutationObserver(() => {
        if (!document.body) return;

        if (!document.getElementById('mun-toggle-btn')) {
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
            clearEditingUserNoteDraft('modal closed without save');
        }

        if (location.href !== lastUrl) {
            lastUrl = location.href;

            lastAutoAppliedModeKey = '';
            lastAutoApplyAt = 0;
            lastDetectedChatId = '';
            lastDetectedChatMode = '';
            lastSeenUserNoteTextarea = null;
            lastSyncedUserNoteKey = '';
            pendingUserNotePatchMode = null;
            clearEditingUserNoteDraft('url changed');

            setTimeout(() => {
                init();
                renderModeSlots();
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
