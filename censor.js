/* eslint-disable no-undef */

// -------------------------
//    Define censor state
// -------------------------

let runtimeSettings = getDefault();
let pageSettingsSnapshotForNotice = null;

function settingsForPopupComparison() {
    return pageSettingsSnapshotForNotice ?? runtimeSettings;
}

function cloneSettingsSnapshot(settings) {
    return normalizeSettings(JSON.parse(JSON.stringify(settings)));
}

let censorStatus = {
    site: window.location.hostname + window.location.pathname,
    settings: settingsForPopupComparison(),
    status: [false, "Loading...", "Loading saved settings..."]
};
let bodyRetryTimeoutId = null;
let mutationObserver = null;
let recensorTimeoutId = null;
let isApplyingCensor = false;
let pageSessionReplacements = 0;

const pendingRecensorRoots = new Set();

let compiledCensorEntries = [];

// -------------------------------
//    DOM observer & scheduling
// -------------------------------

function rebuildCompiledCensorEntries() {
    compiledCensorEntries = [];
    const phrases = Array.isArray(runtimeSettings.censoredPhrases) ? runtimeSettings.censoredPhrases : [];
    for (const entry of phrases) {
        const [word, caseSensitive, isRegex] = Array.isArray(entry)
            ? entry
            : [String(entry || ""), false, false];
        const flags = caseSensitive ? "g" : "gi";
        try {
            const regex = isRegex
                ? new RegExp(word, flags)
                : new RegExp(escapeRegExp(word), flags);
            compiledCensorEntries.push({ regex });
        } catch {
            // skip invalid patterns
        }
    }
}

// Schedule a single checkCensor run after 400 ms when body was missing
function scheduleBodyRetry() {
    if (bodyRetryTimeoutId !== null) {
        return;
    }
    bodyRetryTimeoutId = window.setTimeout(() => {
        bodyRetryTimeoutId = null;
        checkCensor();
    }, 400);
}

// Debounced incremental pass over nodes added since last flush
function scheduleRecensor() {
    if (recensorTimeoutId !== null || runtimeSettings.disableCensor) {
        return;
    }
    recensorTimeoutId = window.setTimeout(() => {
        recensorTimeoutId = null;
        flushPendingRecensor();
    }, 250);
}

// Disconnect observer and clear recensor timer
function stopRecensorObserver() {
    if (mutationObserver) {
        mutationObserver.disconnect();
        mutationObserver = null;
    }
    if (recensorTimeoutId !== null) {
        window.clearTimeout(recensorTimeoutId);
        recensorTimeoutId = null;
    }
    pendingRecensorRoots.clear();
}

// True if ancestor is an Element that contains descendant */
function elementContainsNode(ancestor, descendant) {
    if (!ancestor || ancestor === descendant || ancestor.nodeType !== Node.ELEMENT_NODE) {
        return false;
    }
    return ancestor.contains(descendant);
}

// Drop roots that are nested under another pending root so each subtree is walked once */
function filterTopMostNodes(nodes) {
    const arr = [...nodes];
    return arr.filter((n) => !arr.some((other) => other !== n && elementContainsNode(other, n)));
}

// Start observing body for new nodes and queue incremental censor work
function ensureRecensorObserver() {
    if (mutationObserver || !document.body) {
        return;
    }

    mutationObserver = new MutationObserver((mutations) => {
        if (isApplyingCensor) {
            return;
        }
        let hasNewNodes = false;
        for (let i = 0; i < mutations.length; i++) {
            const mutation = mutations[i];
            if (mutation.type !== "childList" || !mutation.addedNodes.length) {
                continue;
            }
            const list = mutation.addedNodes;
            for (let j = 0; j < list.length; j++) {
                pendingRecensorRoots.add(list[j]);
                hasNewNodes = true;
            }
        }
        if (hasNewNodes) {
            scheduleRecensor();
        }
    });

    mutationObserver.observe(document.body, {
        childList: true,
        subtree: true
    });
}

// -----------------------
//   Text censoring core
// -----------------------

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Apply pre-compiled phrases to text and return { text, actions }
function applyPhrasesToText(text) {
    if (!text || compiledCensorEntries.length === 0) {
        return { text, actions: 0 };
    }

    let result = text;
    let actions = 0;
    const censorChar = runtimeSettings.censorChar;
    const censorMode = runtimeSettings.censorMode;
    const censorSub = runtimeSettings.censorSub;

    for (let i = 0; i < compiledCensorEntries.length; i++) {
        const { regex } = compiledCensorEntries[i];
        regex.lastIndex = 0;
        result = result.replace(regex, (match) => {
            actions += 1;

            if (censorMode === 3) return censorSub;

            const chars = Array.from(match);
            const nonSpaceIndexes = chars
                .map((char, index) => (/\S/.test(char) ? index : -1))
                .filter((index) => index >= 0);

            if (nonSpaceIndexes.length === 0) {
                return match;
            }

            const firstIndex = nonSpaceIndexes[0];
            const lastIndex = nonSpaceIndexes[nonSpaceIndexes.length - 1];

            return chars.map((char, index) => {
                if (!/\S/.test(char)) {
                    return char;
                }
                if (censorMode === 0) {
                    return censorChar;
                }
                if (censorMode === 1) {
                    return index === firstIndex ? char : censorChar;
                }
                if (censorMode === 2) {
                    return (index === firstIndex || index === lastIndex) ? char : censorChar;
                }
                return censorChar;
            }).join("");
        });
    }

    return { text: result, actions };
}

// ---------------
//   DOM walking
// ---------------

// Return true if node is inside an input, textarea, or contenteditable subtree
function isInsideEditable(node) {
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el && el !== document.body) {
        if (el.isContentEditable) {
            return true;
        }
        const tag = el.tagName && el.tagName.toUpperCase();
        if (tag === "INPUT" || tag === "TEXTAREA") {
            return true;
        }
        el = el.parentElement;
    }
    return false;
}

// Walk DOM and replace text in non-editable nodes with censored result
function walkThroughHTMLNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
        if (isInsideEditable(node)) {
            return 0;
        }
        const raw = node.textContent || "";
        if (raw.length === 0) {
            return 0;
        }
        const censorResult = applyPhrasesToText(raw);
        if (censorResult.actions === 0 && censorResult.text === raw) {
            return 0;
        }
        node.textContent = censorResult.text;
        return censorResult.actions;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
        return 0;
    }

    const tag = node.tagName && node.tagName.toUpperCase();
    const skipTag = tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT"
        || tag === "INPUT" || tag === "TEXTAREA";
    if (skipTag) {
        return 0;
    }
    if (isInsideEditable(node)) {
        return 0;
    }

    let actions = 0;
    const children = node.childNodes;
    for (let i = 0; i < children.length; i++) {
        actions += walkThroughHTMLNode(children[i]);
    }
    return actions;
}

function updateEnabledCensorStatus(fullPath) {
    const shown = pageSessionReplacements;
    censorStatus = {
        site: fullPath,
        settings: settingsForPopupComparison(),
        status: [
            true,
            "Enabled",
            shown > 0
                ? `${shown} replacement${shown === 1 ? "" : "s"} made on this page.`
                : "No matching phrases were found."
        ]
    };
}

function flushPendingRecensor() {
    if (pendingRecensorRoots.size === 0 || !document.body) {
        return;
    }

    const hostname = window.location.hostname;
    const fullPath = hostname + window.location.pathname;

    let ignored = runtimeSettings.ignoredSites.some(([site, wholeDomain]) => {
        if (wholeDomain) {
            return hostname === site || hostname.endsWith("." + site);
        }
        return fullPath.startsWith(site);
    });
    if (runtimeSettings.disableCensor) {
        ignored = true;
    }
    if (ignored) {
        pendingRecensorRoots.clear();
        return;
    }

    const topRoots = filterTopMostNodes(pendingRecensorRoots);
    pendingRecensorRoots.clear();

    isApplyingCensor = true;
    let totalActions = 0;
    for (let i = 0; i < topRoots.length; i++) {
        const root = topRoots[i];
        // Skip nodes no longer in the document
        if (root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.TEXT_NODE) {
            if (!root.parentNode) {
                continue;
            }
        }
        totalActions += walkThroughHTMLNode(root);
    }
    isApplyingCensor = false;

    if (totalActions === 0) {
        return;
    }

    pageSessionReplacements += totalActions;
    updateEnabledCensorStatus(fullPath);
}

// ------------------------
//   Censor determination
// ------------------------

// Run censoring if not omitted/disabled and update censorStatus
function checkCensor() {
    try {
        const hostname = window.location.hostname;
        const fullPath = hostname + window.location.pathname;

        let ignored = runtimeSettings.ignoredSites.some(([site, wholeDomain]) => {
            if (wholeDomain) {
                return hostname === site || hostname.endsWith("." + site);
            }
            return fullPath.startsWith(site);
        });

        if (runtimeSettings.disableCensor) {
            ignored = true;
        }

        if (ignored) {
            stopRecensorObserver();
            censorStatus = {
                site: fullPath,
                settings: settingsForPopupComparison(),
                status: [false, "Omitted", "Censoring is disabled for this page by your settings."]
            };
            return;
        }

        if (!document.body) {
            censorStatus = {
                site: fullPath,
                settings: settingsForPopupComparison(),
                status: [false, "Loading...", "Waiting for page content to be available."]
            };
            scheduleBodyRetry();
            return;
        }

        pendingRecensorRoots.clear();
        if (recensorTimeoutId !== null) {
            window.clearTimeout(recensorTimeoutId);
            recensorTimeoutId = null;
        }

        isApplyingCensor = true;
        const totalActions = walkThroughHTMLNode(document.body);
        isApplyingCensor = false;
        ensureRecensorObserver();

        pageSessionReplacements += totalActions;
        updateEnabledCensorStatus(fullPath);
    } finally {
        if (pageSettingsSnapshotForNotice === null) {
            pageSettingsSnapshotForNotice = cloneSettingsSnapshot(runtimeSettings);
        }
    }
}

// -----------------------
//    Message listener
// -----------------------

browser.runtime.onMessage.addListener((message) => {
    if (message && message.type === "GET_CENSOR_STATUS") {
        return Promise.resolve(censorStatus);
    }

    return undefined;
});

browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[SETTINGS_STORAGE_KEY]) {
        return;
    }
    const next = changes[SETTINGS_STORAGE_KEY].newValue;
    runtimeSettings = normalizeSettings(next || getDefault());
    rebuildCompiledCensorEntries();

    window.setTimeout(() => {
        checkCensor();
    }, 0);
});

// ------------------------------
//   Load localStorage settings
// ------------------------------
loadSettings()
    .then((loadedSettings) => {
        runtimeSettings = loadedSettings;
    })
    .catch(() => {
        runtimeSettings = getDefault();
    })
    .finally(() => {
        rebuildCompiledCensorEntries();
        checkCensor();
    });
