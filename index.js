import {
    chat,
    eventSource,
    event_types,
    saveChatDebounced,
    saveSettingsDebounced,
} from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

const META_KEY = 'dynamic_response_pending';

const MODULE = 'dynamic_response';

/**
 * @typedef {Object} AwaitUserSettings
 * @property {boolean} enabled        Master on/off for detection + banner.
 * @property {boolean} confirmDismiss Require a Yes/Cancel popup before dismiss.
 * @property {string}  defaultLabel   Banner text when the tag is emitted empty.
 */

/** @type {AwaitUserSettings} */
const defaultSettings = {
    enabled: true,
    confirmDismiss: true,
    defaultLabel: 'Your turn.',
};

/**
 * The tag the model emits to request a quick user beat.
 * Matches <dynamic_response>optional label</dynamic_response>, case-insensitive,
 * tolerant of whitespace and an optional self-closing slash variant.
 * The label (group 1) may be empty.
 */
const TAG_REGEX = /<dynamic_response>([\s\S]*?)<\/?dynamic_response\/?>/i;
// Global version for scrubbing every occurrence from stored text.
const TAG_REGEX_GLOBAL = /<dynamic_response>[\s\S]*?<\/?dynamic_response\/?>/gi;

const DEFAULT_LABEL = 'Your turn.';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function getSettings() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = structuredClone(defaultSettings);
    }
    // Backfill any missing keys without clobbering existing user values.
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE][key] === undefined) {
            extension_settings[MODULE][key] = value;
        }
    }
    return extension_settings[MODULE];
}

// ---------------------------------------------------------------------------
// Parse + scrub
// ---------------------------------------------------------------------------

/**
 * Extract the dynamic_response label from a message's text, if present.
 * @param {string} text
 * @returns {{ found: boolean, label: string }}
 */
function parseTag(text) {
    if (typeof text !== 'string' || text.length === 0) {
        return { found: false, label: '' };
    }
    const match = TAG_REGEX.exec(text);
    if (!match) {
        return { found: false, label: '' };
    }
    const raw = (match[1] ?? '').trim();
    if (raw.length > 0) {
        return { found: true, label: raw };
    }
    const fallback = getSettings().defaultLabel?.trim() || DEFAULT_LABEL;
    return { found: true, label: fallback };
}

/**
 * Remove every dynamic_response tag (and its inner label) from text.
 * Collapses any whitespace/newlines left dangling where the tag was.
 * @param {string} text
 * @returns {string}
 */
function scrubTag(text) {
    if (typeof text !== 'string' || text.length === 0) {
        return text;
    }
    let cleaned = text.replace(TAG_REGEX_GLOBAL, '');
    // Trim trailing whitespace/newlines the tag may have left behind at the end,
    // and collapse 3+ newlines down to a clean paragraph break.
    cleaned = cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
    return cleaned;
}

// ---------------------------------------------------------------------------
// Pending-state stubs (real per-chat persistence lands in slice two)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Per-chat persistence
// ---------------------------------------------------------------------------

/**
 * Read the pending label from this chat's metadata.
 * @returns {string|null}
 */
function readPendingMeta() {
    try {
        const ctx = getContext();
        const meta = ctx?.chatMetadata;
        if (meta && typeof meta[META_KEY] === 'string') {
            return meta[META_KEY];
        }
    } catch (e) {
        console.error(`[${MODULE}] readPendingMeta failed`, e);
    }
    return null;
}

/**
 * Write or clear the pending label in this chat's metadata, then persist.
 * @param {string|null} label  null clears.
 */
function writePendingMeta(label) {
    try {
        const ctx = getContext();
        if (!ctx?.chatMetadata) {
            return;
        }
        if (label === null) {
            delete ctx.chatMetadata[META_KEY];
        } else {
            ctx.chatMetadata[META_KEY] = label;
        }
        if (typeof ctx.saveMetadata === 'function') {
            ctx.saveMetadata();
        }
    } catch (e) {
        console.error(`[${MODULE}] writePendingMeta failed`, e);
    }
}

// ---------------------------------------------------------------------------
// Banner UI
// ---------------------------------------------------------------------------

/**
 * Find the input form so the banner can sit flush above it.
 * @returns {HTMLElement|null}
 */
function getInputForm() {
    return document.getElementById('send_form')
        || document.getElementById('form_sheld')
        || null;
}

/**
 * Draw (or update) the banner with the given label. Idempotent — calling
 * again replaces the label text, which is how a newer tag overwrites an older.
 * @param {string} label
 */
function drawBanner(label) {
    const form = getInputForm();
    if (!form) {
        console.warn(`[${MODULE}] input form not found; cannot draw banner`);
        return;
    }

    let banner = document.getElementById('dynamic_response_banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'dynamic_response_banner';

        const icon = document.createElement('span');
        icon.className = 'dynamic_response_icon';
        icon.textContent = '✶';

        const text = document.createElement('span');
        text.className = 'dynamic_response_label';

        banner.append(icon, text);
        banner.addEventListener('click', onBannerClick);

        // Insert directly above the input form.
        form.parentElement?.insertBefore(banner, form);
    }

    const labelEl = banner.querySelector('.dynamic_response_label');
    if (labelEl) {
        labelEl.textContent = label;
    }
}

function removeBanner() {
    const banner = document.getElementById('dynamic_response_banner');
    if (banner) {
        banner.remove();
    }
}

/**
 * Click handler: confirm via ST-native popup before dismissing.
 * Guards against the misclick the banner is designed to tolerate.
 */
async function onBannerClick() {
    const settings = getSettings();
    if (!settings.confirmDismiss) {
        clearPendingQuestion();
        return;
    }
    try {
        const confirmed = await callGenericPopup(
            'Dismiss this prompt without answering?',
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: 'Yes', cancelButton: 'Cancel' },
        );
        if (confirmed) {
            clearPendingQuestion();
        }
    } catch (e) {
        console.error(`[${MODULE}] dismiss popup failed`, e);
    }
}

// ---------------------------------------------------------------------------
// Pending-state orchestration
// ---------------------------------------------------------------------------

function setPendingQuestion(label) {
    writePendingMeta(label);
    drawBanner(label);
}

function clearPendingQuestion() {
    writePendingMeta(null);
    removeBanner();
}

/**
 * On chat load/switch: redraw the banner if this chat has a pending question,
 * otherwise make sure no stale banner from a previous chat remains.
 */
function restorePendingForChat() {
    const label = readPendingMeta();
    if (typeof label === 'string') {
        drawBanner(label);
    } else {
        removeBanner();
    }
}

// ---------------------------------------------------------------------------
// Core: handle a freshly received AI message
// ---------------------------------------------------------------------------

// Guard so the same message isn't processed twice when both
// CHARACTER_MESSAGE_RENDERED and MESSAGE_RECEIVED fire for one message.
let lastProcessedSignature = null;

/**
 * Cheap non-cryptographic hash for deduping message text.
 * This avoids treating two different messages of the same length as identical.
 * @param {string} text
 * @returns {string}
 */
function hashText(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

/**
 * Build a dedup signature from the chat index and actual message content.
 * @param {number} index
 * @param {string} text
 * @returns {string}
 */
function getMessageSignature(index, text) {
    return `${index}:${text.length}:${hashText(text)}`;
}

/**
 * Resolve the AI message to inspect. Some events pass the chat index;
 * if the index is missing/invalid we fall back to the last message in chat.
 * @param {number|undefined} messageId
 * @returns {{ index: number, message: any } | null}
 */
function resolveAiMessage(messageId) {
    if (!Array.isArray(chat) || chat.length === 0) {
        return null;
    }
    let index = Number.isInteger(messageId) ? messageId : chat.length - 1;
    if (index < 0 || index >= chat.length) {
        index = chat.length - 1;
    }
    const message = chat[index];
    if (!message || message.is_user || message.is_system) {
        return null;
    }
    return { index, message };
}

/**
 * The newest AI message is the single source of truth: a tag sets/overwrites
 * the pending question; no tag clears it.
 * @param {number} [messageId] index into the chat array (may be undefined)
 */
function processAiMessage(messageId) {
    const settings = getSettings();
    if (!settings.enabled) {
        return;
    }

    const resolved = resolveAiMessage(messageId);
    if (!resolved) {
        return;
    }
    const { index, message } = resolved;

    const text = message.mes ?? '';

    // Dedup: skip if we've already handled this exact message+text.
    const signature = getMessageSignature(index, text);
    if (signature === lastProcessedSignature) {
        return;
    }

    const { found, label } = parseTag(text);

    if (found) {
        const cleaned = scrubTag(text);
        if (cleaned !== text) {
            message.mes = cleaned;
            saveChatDebounced();
        }
        lastProcessedSignature = getMessageSignature(index, cleaned);
        setPendingQuestion(label);
    } else {
        lastProcessedSignature = signature;
        clearPendingQuestion();
    }
}

/**
 * On chat switch, redraw the banner for whatever the NEW chat has pending
 * (or clear it if nothing). Per-chat metadata means each chat keeps its own.
 */
function onChatChanged() {
    lastProcessedSignature = null;
    restorePendingForChat();
}

/**
 * When the user sends a turn, their answer IS the response to the prompt,
 * so the banner has served its purpose and clears.
 */
function onUserMessageSent() {
    if (document.getElementById('dynamic_response_banner') || readPendingMeta() !== null) {
        clearPendingQuestion();
    }
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

function addSettingsPanel() {
    // ST's extensions dropdown uses #extensions_settings2; older/alt layouts
    // use #extensions_settings. Try the standard one first, then fall back.
    const container = document.getElementById('extensions_settings2')
        || document.getElementById('extensions_settings');
    if (!container) {
        console.warn(`[${MODULE}] no settings container found; panel not added`);
        return;
    }
    const settings = getSettings();

    const drawer = document.createElement('div');
    drawer.classList.add('inline-drawer');

    const toggle = document.createElement('div');
    toggle.classList.add('inline-drawer-toggle', 'inline-drawer-header');
    const title = document.createElement('b');
    title.textContent = 'Dynamic Response';
    const chevron = document.createElement('div');
    chevron.classList.add('inline-drawer-icon', 'fa-solid', 'fa-circle-chevron-down', 'down');
    toggle.append(title, chevron);

    const content = document.createElement('div');
    content.classList.add('inline-drawer-content');

    // Master enable
    const enabledLabel = document.createElement('label');
    enabledLabel.classList.add('checkbox_label');
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = settings.enabled;
    enabledInput.addEventListener('change', () => {
        settings.enabled = enabledInput.checked;
        saveSettingsDebounced();
        if (!settings.enabled) {
            removeBanner();
        } else {
            restorePendingForChat();
        }
    });
    const enabledSpan = document.createElement('span');
    enabledSpan.textContent = 'Enabled';
    enabledLabel.append(enabledInput, enabledSpan);

    // Confirm-before-dismiss
    const confirmLabel = document.createElement('label');
    confirmLabel.classList.add('checkbox_label');
    const confirmInput = document.createElement('input');
    confirmInput.type = 'checkbox';
    confirmInput.checked = settings.confirmDismiss;
    confirmInput.addEventListener('change', () => {
        settings.confirmDismiss = confirmInput.checked;
        saveSettingsDebounced();
    });
    const confirmSpan = document.createElement('span');
    confirmSpan.textContent = 'Confirm before dismissing banner';
    confirmLabel.append(confirmInput, confirmSpan);

    // Default label field
    const labelWrap = document.createElement('div');
    labelWrap.style.marginTop = '8px';
    const labelText = document.createElement('small');
    labelText.textContent = 'Default banner text (used when the tag is empty)';
    labelText.style.display = 'block';
    labelText.style.opacity = '0.8';
    labelText.style.marginBottom = '4px';
    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.classList.add('text_pole');
    labelInput.value = settings.defaultLabel;
    labelInput.placeholder = 'Your turn.';
    labelInput.addEventListener('input', () => {
        settings.defaultLabel = labelInput.value;
        saveSettingsDebounced();
    });
    labelWrap.append(labelText, labelInput);

    content.append(enabledLabel, confirmLabel, labelWrap);
    drawer.append(toggle, content);
    container.append(drawer);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
    getSettings();

    // CHARACTER_MESSAGE_RENDERED fires after the message is committed to the
    // chat array and rendered — the reliable trigger. MESSAGE_RECEIVED is kept
    // as a secondary; the dedup guard prevents double-processing.
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, processAiMessage);
    eventSource.on(event_types.MESSAGE_RECEIVED, processAiMessage);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.MESSAGE_SENT, onUserMessageSent);

    addSettingsPanel();

    // Redraw any pending banner for the chat already open at load time.
    restorePendingForChat();

    console.log(`[${MODULE}] loaded`);
}

// Wait for the DOM (and the extensions settings container) to be ready,
// matching the init pattern used by the other extensions in the suite.
jQuery(async () => {
    init();
});
