/* Runs before first paint so reveal animations never flash content. Kept as a file (not inline) so the page CSP can forbid inline scripts. */
document.documentElement.classList.add('js');
