// Handle special characters in regex if needed
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Censor text from list defined in censorlist.js
function censorFromList(text, censorChar = "*") {
    let result = text;

    // eslint-disable-next-line no-undef
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

walkThroughHTMLNode(document.body);