(() => {
    const section = document.querySelector('.trending');
    const track = section?.querySelector('.trailer-track');
    if (!track) return;
    const slides = [...track.children];
    const controls = section.querySelector('.carousel-controls');
    const pause = controls.querySelector('[data-pause]');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const dialog = document.querySelector('.trailer-dialog');
    let paused = reduced.matches;
    let timer;
    controls.hidden = slides.length < 2;
    const index = () => slides.reduce((best, slide, i) => Math.abs(slide.offsetLeft - slides[0].offsetLeft - track.scrollLeft) < Math.abs(slides[best].offsetLeft - slides[0].offsetLeft - track.scrollLeft) ? i : best, 0);
    function move(direction, instant = false) {
        const next = slides[(index() + direction + slides.length) % slides.length];
        track.scrollTo({ left: next.offsetLeft - slides[0].offsetLeft, behavior: instant || reduced.matches ? 'instant' : 'smooth' });
    }
    function update() {
        clearInterval(timer);
        pause.disabled = reduced.matches;
        const label = reduced.matches ? 'Rotación automática desactivada por preferencia del sistema' : paused ? 'Reanudar rotación automática' : 'Pausar rotación automática';
        pause.setAttribute('aria-label', label);
        pause.setAttribute('title', label);
        pause.setAttribute('aria-pressed', String(paused));
        pause.querySelector('[data-icon-pause]').hidden = paused;
        pause.querySelector('[data-icon-play]').hidden = !paused;
        if (!paused && !reduced.matches && !document.hidden && !dialog.open && !section.matches(':hover') && slides.length > 1) timer = setInterval(() => move(1), 8000);
    }
    function moveManually(direction, instant) {
        clearInterval(timer);
        move(direction, instant);
        if (!instant) update();
    }
    controls.querySelector('[data-prev]').addEventListener('click', (e) => moveManually(-1, e.detail === 0));
    controls.querySelector('[data-next]').addEventListener('click', (e) => moveManually(1, e.detail === 0));
    pause.addEventListener('click', () => { paused = !paused; update(); });
    section.addEventListener('mouseenter', () => clearInterval(timer));
    section.addEventListener('mouseleave', update);
    section.addEventListener('focusin', () => clearInterval(timer));
    section.addEventListener('focusout', update);
    track.addEventListener('pointerdown', () => clearInterval(timer));
    track.addEventListener('pointerup', update);
    track.addEventListener('keydown', (e) => {
        if (e.target === track && ['ArrowLeft','ArrowRight'].includes(e.key)) { e.preventDefault(); moveManually(e.key === 'ArrowLeft' ? -1 : 1, true); }
    });
    document.addEventListener('visibilitychange', update);
    reduced.addEventListener('change', () => { paused = reduced.matches || paused; update(); });
    let opener;
    section.querySelectorAll('[data-play]').forEach((link) => link.addEventListener('click', (e) => {
        if (!dialog.showModal) return;
        e.preventDefault(); clearInterval(timer); opener = link;
        const frame = document.createElement('iframe');
        frame.src = link.dataset.play;
        frame.title = `Tráiler de ${link.closest('article').querySelector('h3').textContent}`;
        frame.allow = 'fullscreen; encrypted-media; picture-in-picture';
        frame.allowFullscreen = true;
        frame.referrerPolicy = 'strict-origin-when-cross-origin';
        dialog.querySelector('.trailer-player').replaceChildren(frame);
        dialog.querySelector('[data-youtube]').href = link.href;
        dialog.showModal();
    }));
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { dialog.querySelector('.trailer-player').replaceChildren(); opener?.focus(); });
    update();
})();

(() => {
    const track = document.querySelector('[data-genre-track]');
    const controls = document.querySelector('.genre-rail-controls');
    if (!track || !controls) return;
    const previous = controls.querySelector('[data-genre-prev]');
    const next = controls.querySelector('[data-genre-next]');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let updateFrame;
    function update() {
        controls.hidden = track.scrollWidth <= track.clientWidth + 1;
        previous.disabled = track.scrollLeft <= 1;
        next.disabled = track.scrollLeft >= track.scrollWidth - track.clientWidth - 1;
    }
    function move(direction) {
        const card = track.querySelector('.genre-card');
        if (!card) return;
        const gap = parseFloat(getComputedStyle(track).gap) || 0;
        track.scrollBy({ left: direction * (card.getBoundingClientRect().width + gap), behavior: reduced.matches ? 'auto' : 'smooth' });
    }
    previous.addEventListener('click', () => move(-1));
    next.addEventListener('click', () => move(1));
    track.addEventListener('scroll', () => {
        cancelAnimationFrame(updateFrame);
        updateFrame = requestAnimationFrame(update);
    }, { passive: true });
    if ('ResizeObserver' in window) new ResizeObserver(update).observe(track);
    else window.addEventListener('resize', update);
    update();
})();
