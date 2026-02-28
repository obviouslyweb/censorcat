/* eslint-disable no-undef */

// Handle special characters in regex if needed
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Censor text from list defined in censorlist.js
function censorFromList(text, censorChar = "*") {
    let result = text;

    CENSORED_PHRASES.forEach(([word, caseSensitive]) => {
        // Determine case-sensitive flag if needed
        const flags = caseSensitive ? "g" : "gi";
        // Create regex & censor with it
        const regex = new RegExp(`\\b${escapeRegExp(word)}\\b`, flags);
        result = result.replace(regex, (match) =>
            match.replace(/\S/g, censorChar)
        );
    });

    return result;
}

// Walk through HTML nodes and censor if needed
function walkThroughHTMLNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
        node.textContent = censorFromList(node.textContent);
        return;
    }

    if (
        // Check if node is text, but ignore scripts, styles, inputs, etc.
        node.nodeType === Node.ELEMENT_NODE &&
        !["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"].includes(node.tagName)
    ) {
        for (const child of node.childNodes) {
            walkThroughHTMLNode(child);
        }
    }
}

// Check if censoring should occur
function checkCensor() {
    // Get page URL
    const hostname = window.location.hostname;
    const fullPath = window.location.hostname + window.location.pathname;

    // Check if page should be ignored
    let ignored = IGNORED_SITES.some(([site, wholeDomain]) => {
        if (wholeDomain) {
            // Match any page under the domain
            return hostname === site || hostname.endsWith("." + site);
        } else {
            // Match only the specific path
            return fullPath.startsWith(site);
        }
    });

    // Check if user manually disabled censoring, overrides page check
    if (DISABLE_CENSOR) {
        ignored = true;
    }

    // Only run if page should not be ignored
    if (!ignored) {
        walkThroughHTMLNode(document.body);
        censorStatus = true;
    }
}

let censorStatus = false;
checkCensor();

// Allow popup to query whether censoring ran on this page
browser.runtime.onMessage.addListener((message) => {
    if (message && message.type === "GET_CENSOR_STATUS") {
        return Promise.resolve({ enabled: censorStatus });
    }
    return undefined;
});