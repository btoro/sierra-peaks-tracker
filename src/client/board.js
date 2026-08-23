/**
 * Pilot 06 — client-side board filtering (progressive enhancement).
 *
 * Loaded on the index page only. Intercepts the filter form to filter the
 * already-rendered board live (no reload). Without this script the same
 * form submits natively to `/?q=...&section=...&status=...`, which
 * index.astro applies server-side — so filtering works either way.
 *
 * On load, any filters present in the URL are re-applied to the DOM so the
 * client view matches the server-rendered state.
 */
(function () {
  var form = document.getElementById('filter-form');
  var board = document.getElementById('board');
  var result = document.getElementById('filter-result');
  if (!form || !board || !result) return;

  var tiles = Array.prototype.slice.call(document.querySelectorAll('.flap'));
  var total = tiles.length;

  // Stable text haystack per tile (SPS + PB names, area, id, range).
  var haystacks = tiles.map(function (el) {
    return (el.getAttribute('data-search') || '').toLowerCase();
  });

  var sections = Array.prototype.slice.call(board.querySelectorAll('.board-section'));

  function apply(q, section, status) {
    q = (q || '').trim().toLowerCase();
    section = section || null;
    var shown = 0;

    tiles.forEach(function (el, i) {
      var matchQ = !q || haystacks[i].indexOf(q) !== -1;
      var matchS = !section || el.getAttribute('data-section') === section;
      var matchT =
        status === 'all' ||
        (status === 'done' ? el.getAttribute('data-done') === '1' : el.getAttribute('data-done') === '0');
      var show = matchQ && matchS && matchT;
      el.style.display = show ? '' : 'none';
      if (show) shown += 1;
    });

    // Hide sections with no visible tiles.
    sections.forEach(function (sec) {
      var secTiles = sec.querySelectorAll('.flap');
      var n = 0;
      for (var i = 0; i < secTiles.length; i++) {
        if (secTiles[i].style.display !== 'none') n += 1;
      }
      sec.hidden = n === 0;
    });

    result.textContent =
      'Showing ' + shown + ' of ' + total + ' peaks' + (shown !== total ? ' (filtered)' : '');

    // Keep URL in sync via history.replaceState (no reload).
    var params = new URLSearchParams();
    if (q) params.set('q', q);
    if (section) params.set('section', section);
    if (status !== 'all') params.set('status', status);
    var qs = params.toString();
    var url = window.location.pathname + (qs ? '?' + qs : '');
    window.history.replaceState(null, '', url);
  }

  function current() {
    var fd = new FormData(form);
    return { q: fd.get('q') || '', section: fd.get('section') || null, status: fd.get('status') || 'all' };
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var s = current();
    apply(s.q, s.section, s.status);
  });

  // Live: update as the user types or changes selects.
  var qInput = form.querySelector('input[type="search"]');
  if (qInput) {
    qInput.addEventListener('input', function () {
      var s = current();
      apply(s.q, s.section, s.status);
    });
  }
  Array.prototype.forEach.call(form.querySelectorAll('select'), function (sel) {
    sel.addEventListener('change', function () {
      var s = current();
      apply(s.q, s.section, s.status);
    });
  });
})();
