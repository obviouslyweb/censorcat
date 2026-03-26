/* eslint-disable no-undef */

// -------------------------
//    Define censor state
// -------------------------

// Initialize runtime settings with defaults
let runtimeSettings = getDefault();
let pageSettingsSnapshotForNotice = null;
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

// Returns the settings for the popup comparison
function settingsForPopupComparison() {
    return pageSettingsSnapshotForNotice ?? runtimeSettings;
}

// Clones the settings snapshot
function cloneSettingsSnapshot(settings) {
    return normalizeSettings(JSON.parse(JSON.stringify(settings)));
}

// -------------------------------
//    DOM observer & scheduling
// -------------------------------

// Rebuilds the compiled censor entries from the runtime settings
function rebuildCompiledCensorEntries() {
    // Clear the compiled censor entries
    compiledCensorEntries = [];
    // Get the phrases from the runtime settings
    const phrases = Array.isArray(runtimeSettings.censoredPhrases) ? runtimeSettings.censoredPhrases : [];
    // Loop through the phrases
    for (const entry of phrases) {
        // Get the word, case sensitive, and regex from the entry
        const [word, caseSensitive, isRegex] = Array.isArray(entry)
            ? entry
            : [String(entry || ""), false, false];
        const flags = caseSensitive ? "g" : "gi";
        // Try to compile the regex
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

// Schedules a recensor should the page contents update or change, used to avoid redundant censoring
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
    // If the mutation observer is set, disconnect it
    if (mutationObserver) {
        mutationObserver.disconnect();
        mutationObserver = null;
    }
    // If the recensor timeout is set, clear it
    if (recensorTimeoutId !== null) {
        window.clearTimeout(recensorTimeoutId);
        recensorTimeoutId = null;
    }
    // Clear the pending recensor roots
    pendingRecensorRoots.clear();
}

// True if ancestor is an element that contains descendant */
function elementContainsNode(ancestor, descendant) {
    if (!ancestor || ancestor === descendant || ancestor.nodeType !== Node.ELEMENT_NODE) {
        return false;
    }
    return ancestor.contains(descendant);
}

// Drop roots that are nested under another pending root so each subtree is walked once */
function filterTopMostNodes(nodes) {
    // Create a new array from the nodes
    const arr = [...nodes];
    // Filter the nodes to only include the top most nodes
    return arr.filter((n) => !arr.some((other) => other !== n && elementContainsNode(other, n)));
}

// Start observing body for new nodes and queue incremental censor work
function ensureRecensorObserver() {
    // If the mutation observer is already set or the document body is not available, return
    if (mutationObserver || !document.body) {
        return;
    }

    // Create a new mutation observer
    mutationObserver = new MutationObserver((mutations) => {
        if (isApplyingCensor) {
            return;
        }
        let hasNewNodes = false;
        // Loop through the mutations
        for (let i = 0; i < mutations.length; i++) {
            const mutation = mutations[i];
            // If the mutation is not a childList or there are no added nodes, skip
            if (mutation.type !== "childList" || !mutation.addedNodes.length) {
                continue;
            }
            // Get the added nodes
            const list = mutation.addedNodes;
            // Loop through the added nodes
            for (let j = 0; j < list.length; j++) {
                // Add the added node to the pending recensor roots
                pendingRecensorRoots.add(list[j]);
                // Set hasNewNodes to true
                hasNewNodes = true;
            }
        }
        // If there are new nodes, schedule a recensor
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
    // Escape special characters in the text
    // Used to prevent the regex from matching special characters
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replace text with censored results depending on mode
function applyPhrasesToText(text) {
    // If the text is empty or there are no compiled censor entries, return the text and 0 actions
    if (!text || compiledCensorEntries.length === 0) {
        return { text, actions: 0 };
    }

    // Initialize result and actions
    let result = text;
    let actions = 0;
    const censorChar = runtimeSettings.censorChar;
    const censorMode = runtimeSettings.censorMode;
    const censorSub = runtimeSettings.censorSub;

    // Loop through the compiled censor entries
    for (let i = 0; i < compiledCensorEntries.length; i++) {
        const { regex } = compiledCensorEntries[i];
        regex.lastIndex = 0;
        result = result.replace(regex, (match) => {
            actions += 1;

            // If the censor mode is 3, return the substitute phrase
            if (censorMode === 3) return censorSub;

            // Get the characters in the match
            const chars = Array.from(match);
            // Get the indexes of the non-space characters
            const nonSpaceIndexes = chars
                // Map the characters to their indexes
                .map((char, index) => (/\S/.test(char) ? index : -1))
                .filter((index) => index >= 0);

            // If there are no non-space characters, return the match
            if (nonSpaceIndexes.length === 0) {
                return match;
            }

            // Get the first and last indexes of the non-space characters
            const firstIndex = nonSpaceIndexes[0];
            const lastIndex = nonSpaceIndexes[nonSpaceIndexes.length - 1];

            // Loop through the characters in the match depending on the censor mode
            return chars.map((char, index) => {
                if (!/\S/.test(char)) {
                    // If the character is not a non-space, return it
                    return char;
                }
                if (censorMode === 0) {
                    // Censor all letters
                    return censorChar;
                }
                if (censorMode === 1) {
                    // Censor the first letter only
                    return index === firstIndex ? char : censorChar;
                }
                if (censorMode === 2) {
                    // Censor the first and last letter only
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
            // Node's contents can be edited by the user
            return true;
        }
        const tag = el.tagName && el.tagName.toUpperCase();
        if (tag === "INPUT" || tag === "TEXTAREA") {
            // Node is input or textarea
            return true;
        }
        el = el.parentElement;
    }
    // Node isn't editable, return false
    return false;
}

// Walk DOM and replace text in non-editable nodes with censored result
function walkThroughHTMLNode(node) {
    // If the node is a text node, check if it is inside an editable node
    if (node.nodeType === Node.TEXT_NODE) {
        if (isInsideEditable(node)) {
            // If the text node is inside an editable node, skip it
            return 0;
        }
        const raw = node.textContent || "";
        if (raw.length === 0) {
            // If the text node is empty, also skip it
            return 0;
        }
        const censorResult = applyPhrasesToText(raw);
        if (censorResult.actions === 0 && censorResult.text === raw) {
            // If the text node was not previosuly censored, skip
            return 0;
        }
        node.textContent = censorResult.text;
        return censorResult.actions;
    }

    // If the node is not an element node, skip it
    if (node.nodeType !== Node.ELEMENT_NODE) {
        return 0;
    }

    // If the node is a script, style, noscript, input, or textarea node, skip it
    const tag = node.tagName && node.tagName.toUpperCase();
    const skipTag = tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT"
        || tag === "INPUT" || tag === "TEXTAREA";
    if (skipTag) {
        return 0;
    }
    if (isInsideEditable(node)) {
        return 0;
    }

    // Walk through the children of the node
    let actions = 0;
    const children = node.childNodes;
    for (let i = 0; i < children.length; i++) {
        // Return the number of actions taken
        actions += walkThroughHTMLNode(children[i]);
    }
    return actions;
}

// Update the censor status when the censor is enabled
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
    // If there are no pending recensor roots or the document body is not available, return
    if (pendingRecensorRoots.size === 0 || !document.body) {
        return;
    }

    // Obtain hostname and path of focused tab
    const hostname = window.location.hostname;
    const fullPath = hostname + window.location.pathname;

    // Determine if page should be ignored from censoring
    // This extra check is redundant since checkCensor should already know but it's here just to be safe
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

    // Filter top most nodes & clear pending recensor roots
    const topRoots = filterTopMostNodes(pendingRecensorRoots);
    pendingRecensorRoots.clear();

    // Apply censor to the page body
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

    // Update page session replacements and censor status
    pageSessionReplacements += totalActions;
    updateEnabledCensorStatus(fullPath);
}

// ------------------------
//   Censor determination
// ------------------------

// Run censoring if not omitted/disabled and update censorStatus
function checkCensor() {
    try {
        // Obtain hostname and path of focused tab
        const hostname = window.location.hostname;
        const fullPath = hostname + window.location.pathname;

        // Determine if page should be ignored from censoring
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
            // Stop recensor observer and update censor status
            stopRecensorObserver();
            censorStatus = {
                site: fullPath,
                settings: settingsForPopupComparison(),
                status: [false, "Disabled", "Censoring is disabled for this page by your settings."]
            };
            return;
        }

        // If the page body is not available, schedule a retry
        if (!document.body) {
            censorStatus = {
                site: fullPath,
                settings: settingsForPopupComparison(),
                status: [false, "Loading...", "Waiting for page content to be available."]
            };
            scheduleBodyRetry();
            return;
        }

        // Clear pending recensor roots and timer
        pendingRecensorRoots.clear();
        if (recensorTimeoutId !== null) {
            window.clearTimeout(recensorTimeoutId);
            recensorTimeoutId = null;
        }

        // Apply censor to the page body
        isApplyingCensor = true;
        const totalActions = walkThroughHTMLNode(document.body);
        isApplyingCensor = false;
        ensureRecensorObserver();

        // Update page session replacements and censor status
        pageSessionReplacements += totalActions;
        updateEnabledCensorStatus(fullPath);
    } finally {
        // Update page settings snapshot for notice
        if (pageSettingsSnapshotForNotice === null) {
            pageSettingsSnapshotForNotice = cloneSettingsSnapshot(runtimeSettings);
        }
    }
}

// -----------------------
//    Message listener
// -----------------------

// Used to get the censor status from the extension
browser.runtime.onMessage.addListener((message) => {
    if (message && message.type === "GET_CENSOR_STATUS") {
        return Promise.resolve(censorStatus);
    }

    return undefined;
});

// Used to update the runtime settings when the user changes them
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
        // Set runtime settings
        runtimeSettings = loadedSettings;
    })
    .catch(() => {
        // Fall back to defaults
        runtimeSettings = getDefault();
    })
    .finally(() => {
        // Rebuild compiled censor entries and check censor
        rebuildCompiledCensorEntries();
        checkCensor();
    });
