/* eslint-disable no-undef */

// -------------------------
//    Define censor state
// -------------------------

let runtimeSettings = getDefault();
let censorStatus = {
    site: window.location.hostname + window.location.pathname,
    settings: runtimeSettings,
    status: [false, "Loading...", "Loading saved settings..."]
};
let bodyRetryTimeoutId = null;
let mutationObserver = null;
let recensorTimeoutId = null;
let isApplyingCensor = false;

// -------------------------------
//    DOM observer & scheduling
// -------------------------------

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

// Schedule a single checkCensor run after 250 ms when new nodes are added
function scheduleRecensor() {
    if (recensorTimeoutId !== null || runtimeSettings.disableCensor) {
        return;
    }
    recensorTimeoutId = window.setTimeout(() => {
        recensorTimeoutId = null;
        checkCensor();
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
}

// Start observing body for new nodes and call scheduleRecensor when they appear
function ensureRecensorObserver() {
    if (mutationObserver || !document.body) {
        return;
    }

    mutationObserver = new MutationObserver((mutations) => {
        if (isApplyingCensor) {
            return;
        }
        const hasNewNodes = mutations.some((mutation) =>
            mutation.type === "childList" && mutation.addedNodes && mutation.addedNodes.length > 0
        );
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

// Apply phrase list to text and return { text, actions }
function censorFromList(text, censorChar = "*", censorMode = 0, censorSub = "[CENSORED]", phrases = []) {
    let result = text;
    let actions = 0;

    phrases.forEach(([word, caseSensitive, isRegex]) => {
        const flags = caseSensitive ? "g" : "gi";
        let regex = null;
        try {
            regex = isRegex
                ? new RegExp(word, flags)
                : new RegExp(escapeRegExp(word), flags);
        } catch {
            return;
        }

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
    });

    return { text: result, actions };
}

// ---------------
//   DOM walking
// ---------------

// Return true if node is inside an input, textarea, or contenteditable
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
        const censorResult = censorFromList(
            node.textContent || "",
            runtimeSettings.censorChar,
            runtimeSettings.censorMode,
            runtimeSettings.censorSub,
            runtimeSettings.censoredPhrases
        );
        node.textContent = censorResult.text;
        return censorResult.actions;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
        return 0;
    }

    const tag = node.tagName && node.tagName.toUpperCase();
    const skipTag = ["SCRIPT", "STYLE", "NOSCRIPT", "INPUT", "TEXTAREA"].includes(tag);
    if (skipTag) {
        return 0;
    }
    if (isInsideEditable(node)) {
        return 0;
    }

    let actions = 0;
    for (const child of node.childNodes) {
        actions += walkThroughHTMLNode(child);
    }
    return actions;
}

// ----------------------------------------------------------
//   Censor determination (whether or not we should censor)
// ----------------------------------------------------------

// Run censoring if not omitted/disabled and update censorStatus
function checkCensor() {
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
            settings: runtimeSettings,
            status: [false, "Omitted", "Censoring is disabled for this page by your settings."]
        };
        return;
    }

    if (!document.body) {
        censorStatus = {
            site: fullPath,
            settings: runtimeSettings,
            status: [false, "Loading...", "Waiting for page content to be available."]
        };
        scheduleBodyRetry();
        return;
    }

    isApplyingCensor = true;
    const totalActions = walkThroughHTMLNode(document.body);
    isApplyingCensor = false;
    ensureRecensorObserver();

    censorStatus = {
        site: fullPath,
        settings: runtimeSettings,
        status: [
            true,
            "Enabled",
            totalActions > 0
                ? `${totalActions} replacement${totalActions === 1 ? "" : "s"} made on this page.`
                : "No matching phrases were found."
        ]
    };
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
        checkCensor();
    });
