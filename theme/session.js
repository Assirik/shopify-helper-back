/*
 * Capture du téléphone saisi dans le formulaire de commande + infos navigateur.
 * Autonome : aucune dépendance, aucune variable globale, n'échoue jamais.
 * Voir README.md pour l'installation.
 */
(function () {
  'use strict';

  // À remplacer à l'installation par l'URL de l'API, ex. https://api.exemple.com/api/session
  var ENDPOINT = 'https://REMPLACER-PAR-LE-DOMAINE-API/api/session';

  var PAUSE_MS = 800; // délai sans frappe avant envoi
  var MIN_DIGITS = 8; // nombre minimal de chiffres pour envoyer
  var COOKIE_MAX_AGE = 90 * 24 * 60 * 60; // 90 jours, en secondes

  // Du plus précis au plus large : le premier qui trouve un champ gagne.
  var PHONE_SELECTORS = [
    'input[type="tel"]',
    'input[autocomplete="tel"]',
    'input[name*="phone" i]', // couvre phone, telephone, téléphone, billing_phone, contact[phone]…
    'input[name="tel" i]' // nom exactement « tel » (jamais « hotel », « intel »…)
  ];

  var timer = null;
  var lastSentDigits = '';

  function readCookie(name) {
    try {
      var parts = document.cookie ? document.cookie.split('; ') : [];
      for (var i = 0; i < parts.length; i++) {
        var eq = parts[i].indexOf('=');
        if (eq > 0 && parts[i].slice(0, eq) === name) {
          return parts[i].slice(eq + 1) || null;
        }
      }
    } catch (e) {}
    return null;
  }

  function readClickId() {
    try {
      var value = new URLSearchParams(location.search).get('fbclid');
      return value ? value : null;
    } catch (e) {
      return null;
    }
  }

  // Clic sur une publicité Meta sans cookie _fbc : on le pose, comme le fait Meta.
  function ensureClickCookie() {
    try {
      var clickId = readClickId();
      if (clickId && !readCookie('_fbc')) {
        document.cookie =
          '_fbc=fb.1.' + Date.now() + '.' + clickId +
          '; path=/; max-age=' + COOKIE_MAX_AGE + '; SameSite=Lax';
      }
    } catch (e) {}
  }

  function countDigits(value) {
    return String(value || '').replace(/\D/g, '').length;
  }

  // Rang du premier sélecteur que l'élément satisfait, -1 sinon.
  function phoneRank(el) {
    try {
      if (!el || !el.matches) return -1;
      for (var i = 0; i < PHONE_SELECTORS.length; i++) {
        if (el.matches(PHONE_SELECTORS[i])) return i;
      }
    } catch (e) {}
    return -1;
  }

  // Champs téléphone d'une racine, du rang le plus précis au plus large. Pour un formulaire,
  // `elements` inclut aussi les champs rattachés par l'attribut `form` hors de son arborescence.
  function listPhoneFields(root) {
    var result = [];
    try {
      var all = root.elements || root.querySelectorAll('input');
      for (var i = 0; i < PHONE_SELECTORS.length; i++) {
        for (var j = 0; j < all.length; j++) {
          if (phoneRank(all[j]) === i) result.push(all[j]);
        }
      }
    } catch (e) {}
    return result;
  }

  function findPhoneField(root) {
    return listPhoneFields(root)[0] || null;
  }

  // Un champ saisi compte s'il est du meilleur rang présent dans son formulaire.
  function isPhoneInput(el) {
    var rank = phoneRank(el);
    if (rank < 0) return false;
    var best = findPhoneField(el.form || document);
    return !best || phoneRank(best) >= rank;
  }

  function send(field) {
    try {
      var value = field && typeof field.value === 'string' ? field.value.trim() : '';
      if (countDigits(value) < MIN_DIGITS) return;
      var digits = value.replace(/\D/g, '');
      if (digits === lastSentDigits) return;

      var body = JSON.stringify({
        phone: value,
        fbp: readCookie('_fbp'),
        fbc: readCookie('_fbc'),
        fbclid: readClickId(),
        userAgent: navigator.userAgent,
        pageUrl: location.href
      });

      var queued = false;
      try {
        queued = typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(ENDPOINT, body);
      } catch (e) {}
      if (queued) {
        lastSentDigits = digits;
      } else if (typeof fetch === 'function') {
        // Le numéro n'est mémorisé qu'une fois l'envoi abouti : un échec permet de réessayer.
        fetch(ENDPOINT, {
          method: 'POST',
          mode: 'no-cors',
          keepalive: true,
          headers: { 'Content-Type': 'text/plain' },
          body: body
        }).then(function () {
          lastSentDigits = digits;
        }, function () {});
      }
    } catch (e) {}
  }

  function cancelPending() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function onInput(event) {
    try {
      var field = event.target;
      if (!isPhoneInput(field)) return;
      cancelPending();
      timer = setTimeout(function () {
        timer = null;
        send(field);
      }, PAUSE_MS);
    } catch (e) {}
  }

  function onSubmit(event) {
    try {
      var form = event.target;
      if (!form || typeof form.querySelector !== 'function') return;
      var fields = listPhoneFields(form);
      for (var i = 0; i < fields.length; i++) {
        if (countDigits(fields[i].value) >= MIN_DIGITS) {
          cancelPending();
          send(fields[i]);
          return;
        }
      }
      // Aucun champ valable : l'envoi en attente (saisie ailleurs) n'est pas annulé.
    } catch (e) {}
  }

  try {
    ensureClickCookie();
    document.addEventListener('input', onInput, true);
    document.addEventListener('submit', onSubmit, true);
  } catch (e) {}
})();
