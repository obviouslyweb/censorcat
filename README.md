![CensorCAT logo](icons/icon-256.png)

# censorcat - *Censor Curation And Text-filtering tool*
Dynamic censoring extension for the Firefox Browser. Currently in active development.

## Features
* Censors words/phrases from `censorlist.js` with regex
* Define case-sensitive filtering per censored element

## Current To-Do List
- [ ] Fix bug with case-sensitivity not functioning in certain instances
- [ ] Retrigger censoring when censorlist.js is edited
- [ ] Regex handling (add param in censorlist.js array items to define phrase or regex, handle differently depending in content.js)
- [ ] Ability to change censor character (replace * with custom character)
- [ ] Retrigger censoring when page updates
- [ ] Customize filter modes (full hide, first letter, etc. based on word)
- [ ] Fix bugs on censoring DuckDuckGo
- [ ] Ability to add/remove words & censoring modes in extension GUI
- [ ] Ability to omit certain websites from censoring

## Information
CensorCAT is being developed in JavaScript with the usage of Firefox WebExtensionsAPI. This is my first time working on something like this, so feedback and suggestions in issues would be greatly appreciated!

CensorCAT logo created by me in Adobe Illustrator. Please do not use without permission.