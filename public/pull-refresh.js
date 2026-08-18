// pull-refresh.js — custom pull-to-refresh for fixed-layout pages
(function () {
  const THRESHOLD = 75; // px to pull before triggering reload
  let startY = 0, curY = 0, pulling = false;

  // The scrollable element: #messages in room.html, otherwise the document
  function scrollTop() {
    const el = document.getElementById('messages');
    return el ? el.scrollTop : (window.scrollY || document.documentElement.scrollTop);
  }

  // Visual indicator bar
  const bar = document.createElement('div');
  bar.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'height:3px',
    'background:#8B2FC9', 'transform:scaleX(0)', 'transform-origin:left',
    'z-index:99999', 'pointer-events:none', 'transition:transform .05s linear'
  ].join(';');
  document.body.appendChild(bar);

  // Spinner shown when reload is triggered
  const spinner = document.createElement('div');
  spinner.style.cssText = [
    'position:fixed', 'top:12px', 'left:50%', 'transform:translateX(-50%)',
    'width:28px', 'height:28px', 'border:3px solid #3d1f6b',
    'border-top-color:#8B2FC9', 'border-radius:50%',
    'animation:ptr-spin .6s linear infinite',
    'z-index:99999', 'display:none', 'pointer-events:none'
  ].join(';');
  document.body.appendChild(spinner);

  // Keyframe for spinner
  const style = document.createElement('style');
  style.textContent = '@keyframes ptr-spin { to { transform: translateX(-50%) rotate(360deg); } }';
  document.head.appendChild(style);

  document.addEventListener('touchstart', function (e) {
    if (scrollTop() === 0) {
      startY = e.touches[0].clientY;
      pulling = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', function (e) {
    if (!pulling) return;
    curY = e.touches[0].clientY;
    const dy = curY - startY;
    if (dy <= 0) { pulling = false; bar.style.transform = 'scaleX(0)'; return; }
    bar.style.transform = 'scaleX(' + Math.min(dy / THRESHOLD, 1) + ')';
  }, { passive: true });

  document.addEventListener('touchend', function () {
    if (!pulling) return;
    pulling = false;
    const dy = curY - startY;
    if (dy >= THRESHOLD) {
      bar.style.transform = 'scaleX(1)';
      spinner.style.display = 'block';
      setTimeout(function () { location.reload(); }, 250);
    } else {
      bar.style.transform = 'scaleX(0)';
    }
  });
})();
