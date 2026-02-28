/* eslint-disable no-unused-vars */

const CENSORED_PHRASES = [
    // Format: [ "phrase", case-sensitive, regex ]
    [ "assignment", false, false ],
    [ "roblox", false, false ],
    [ "BYU-Idaho", false, false ],
    // All of these are temporary for testing
];

const IGNORED_SITES = [
    // Format: [ "site.url", censor all pages under domain ]
    // [ "en.wikipedia.org", true ],
    [ "roblox.com/home", false ]
    // All of these are temporary for testing
];

const DISABLE_CENSOR = false;