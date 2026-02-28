/* eslint-disable no-undef */

// Escape literal text before converting it into RegExp source
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Runtime state used during page processing
let runtimeSettings = getDefault();
let censorStatus = {
    site: window.location.hostname + window.location.pathname,
    settings: runtimeSettings,
    status: [false, "Loading...", "Loading saved settings..."]
};

// Retry observer/timer state used for late-loading pages and dynamic DOMs
let bodyRetryTimeoutId = null;
let mutationObserver = null;
let recensorTimeoutId = null;
let isApplyingCensor = false;

// Retry once body exists
function scheduleBodyRetry() {
    if (bodyRetryTimeoutId !== null) {
        return;
    }
    bodyRetryTimeoutId = window.setTimeout(() => {
        bodyRetryTimeoutId = null;
        checkCensor();
    }, 400);
}

// Debounced re-censor trigger for MutationObserver updates
function scheduleRecensor() {
    if (recensorTimeoutId !== null || runtimeSettings.disableCensor) {
        return;
    }
    recensorTimeoutId = window.setTimeout(() => {
        recensorTimeoutId = null;
        checkCensor();
    }, 250);
}

// Stop DOM observation when censoring is disabled
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

// Watch dynamic page updates so late-inserted text is also censored
function ensureRecensorObserver() {
    if (mutationObserver || !document.body) {
        return;
    }

    mutationObserver = new MutationObserver((mutations) => {
        // Skip observer-triggered loops while text is being edited
        if (isApplyingCensor) {
            return;
        }

        // Only re-run if actual text or nodes changed
        const hasRelevantChange = mutations.some((mutation) =>
            mutation.type === "characterData" ||
            (mutation.type === "childList" && mutation.addedNodes && mutation.addedNodes.length > 0)
        );

        if (hasRelevantChange) {
            scheduleRecensor();
        }
    });

    // Observe the full body tree for text and child changes
    mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
    });
}

// Apply censor rules to a plain string and return transformed text + count
function censorFromList(text, censorChar = "*", censorMode = 0, censorSub = "[CENSORED]", phrases = []) {
    let result = text;
    let actions = 0;

    phrases.forEach(([word, caseSensitive, isRegex]) => {
        const flags = caseSensitive ? "g" : "gi";
        let regex = null;
        try {
            // Regex entries are treated as raw source
            // others are escaped literals
            regex = isRegex
                ? new RegExp(word, flags)
                : new RegExp(escapeRegExp(word), flags);
        } catch {
            // Ignore invalid regex entries so one bad rule doesn't break all censoring
            return;
        }

        result = result.replace(regex, (match) => {
            actions += 1;

            // if substitution mode, use phrase
            if (censorMode === 3) {
                return censorSub;
            }

            const chars = Array.from(match);

            // only mask visible characters
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

// Recursively walk the DOM and censor text nodes
function walkThroughHTMLNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
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

    if (
        node.nodeType === Node.ELEMENT_NODE &&

        // Skip non-content & user input elements
        !["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"].includes(node.tagName)
    ) {
        let actions = 0;
        for (const child of node.childNodes) {
            actions += walkThroughHTMLNode(child);
        }
        return actions;
    }

    return 0;
}

// Decide whether to censor, then update status payload
function checkCensor() {
    const hostname = window.location.hostname;
    const fullPath = window.location.hostname + window.location.pathname;

    // Domain/path ignore matching
    let ignored = runtimeSettings.ignoredSites.some(([site, wholeDomain]) => {
        if (wholeDomain) {
            return hostname === site || hostname.endsWith("." + site);
        }
        return fullPath.startsWith(site);
    });

    // If global disable is on, pass
    if (runtimeSettings.disableCensor) {
        ignored = true;
    }

    // If disabled, send message & stop dom observer
    if (ignored) {
        stopRecensorObserver();
        censorStatus = {
            site: fullPath,
            settings: runtimeSettings,
            status: [false, "Omitted", "Censoring is disabled for this page by your settings."]
        };
        return;
    }

    // Delay if body is still unavailable
    if (!document.body) {
        censorStatus = {
            site: fullPath,
            settings: runtimeSettings,
            status: [false, "Loading...", "Waiting for page content to be available."]
        };
        scheduleBodyRetry();
        return;
    }

    // Apply censoring and then resume observer for live page updates
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

// Get current page status
browser.runtime.onMessage.addListener((message) => {
    if (message && message.type === "GET_CENSOR_STATUS") {
        return Promise.resolve(censorStatus);
    }

    return undefined;
});

// Get settings from localstorage and run initial censor pass
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