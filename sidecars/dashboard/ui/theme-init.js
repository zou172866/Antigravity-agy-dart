    (function () {
      try {
        var saved = String((typeof localStorage !== 'undefined' && localStorage.getItem('agy-dart-ui-theme')) || '').trim().toLowerCase();
        var mode = saved === 'light' || saved === 'mocha' || saved === 'auto' ? saved : 'auto';
        var dark = mode === 'mocha' || (mode === 'auto' && typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        var root = document.documentElement;
        if (root) {
          if (root.dataset) root.dataset.themeMode = mode;
          root.setAttribute('data-theme', dark ? 'mocha' : 'light');
        }
      } catch {}
    })();
