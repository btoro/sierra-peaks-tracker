/**
 * Sierra Peaks — one-page flip-card enhancement.
 *
 * Dependency-free, attaches once to every .flip-card button. Clicking toggles
 * the card's data-flip (front <-> back) and keeps aria-pressed in sync.
 * Pressing Escape while a card is focused returns it to the front.
 * No search, filtering, navigation, or detail pages.
 */
(function () {
  var cards = document.querySelectorAll('.flip-card');

  cards.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var state = btn.dataset.flip === 'front' ? 'back' : 'front';
      btn.dataset.flip = state;
      btn.setAttribute('aria-pressed', state === 'back' ? 'true' : 'false');
    });

    btn.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        btn.dataset.flip = 'front';
        btn.setAttribute('aria-pressed', 'false');
      }
    });
  });
})();
