/* eslint-disable no-unused-vars */

// Defaults that the extension uses when nothing is in localstorage

// Default fullstop censor toggle
const DISABLE_CENSOR = false;

// Default phrases to censor
const CENSORED_PHRASES = [
    // Format: [ "phrase", case-sensitive, regex ]
    [ "Tutorials", false, false ],
    [ "certificates", false, false ]
];

// Default replacement char & substitute phrase
const CENSOR_CHAR = "*";
const CENSOR_SUB = "!?$%#";

// 0 = hide all letters
// 1 = first letter only
// 2 = first & last letter only
// 3 = substitute phrase
const CENSOR_MODE = 0;

// omit list for sites to ignore
const IGNORED_SITES = [
    // Format: [ "site.url", censor all pages under domain ]
    [ "wikipedia.org", true ]
];
