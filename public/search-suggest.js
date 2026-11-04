// Autocompletado del buscador del header: muestra sugerencias mientras se escribe.
(() => {
    const form = document.querySelector('.header-search');
    const input = form?.querySelector('input[name="q"]');
    const typeSelect = form?.querySelector('select[name="tipo"]');
    if (!form || !input) return;

    const list = document.createElement('ul');
    list.className = 'search-suggest';
    list.id = 'search-suggest-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Sugerencias de búsqueda');
    list.hidden = true;
    form.append(list);

    input.setAttribute('role', 'combobox');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('aria-expanded', 'false');

    const icons = { movie: '▶', actor: '●', director: '◆', genre: '#', keyword: '⌕' };
    let items = [];
    let active = -1;
    let timer;
    let controller;

    // Arma el texto con la parte que coincide resaltada, sin usar innerHTML.
    function highlighted(label, term) {
        const fragment = document.createDocumentFragment();
        const start = label.toLowerCase().indexOf(term.toLowerCase());
        if (start < 0) {
            fragment.append(label);
            return fragment;
        }
        const mark = document.createElement('mark');
        mark.textContent = label.slice(start, start + term.length);
        fragment.append(label.slice(0, start), mark, label.slice(start + term.length));
        return fragment;
    }

    function close() {
        list.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        active = -1;
    }

    function setActive(index) {
        const options = list.querySelectorAll('[role="option"]');
        options.forEach((option, i) => option.setAttribute('aria-selected', String(i === index)));
        active = index;
        if (options[index]) {
            input.setAttribute('aria-activedescendant', options[index].id);
            options[index].scrollIntoView({ block: 'nearest' });
        } else {
            input.removeAttribute('aria-activedescendant');
        }
    }

    function render(term) {
        list.replaceChildren();
        // La última opción siempre permite buscar el texto completo, como Enter.
        const entries = [...items, { type: 'search', label: `Buscar "${term}"`, detail: 'Ver todos los resultados' }];
        entries.forEach((item, index) => {
            const option = document.createElement('li');
            option.id = `search-suggest-${index}`;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', 'false');
            option.className = `search-suggest-item search-suggest-${item.type}`;

            const icon = document.createElement('span');
            icon.className = 'search-suggest-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = icons[item.type] || '⌕';

            const text = document.createElement('span');
            text.className = 'search-suggest-text';
            const label = document.createElement('span');
            label.className = 'search-suggest-label';
            label.append(item.type === 'search' ? item.label : highlighted(item.label, term));
            const detail = document.createElement('span');
            detail.className = 'search-suggest-detail';
            detail.textContent = item.detail;
            text.append(label, detail);

            option.append(icon, text);
            option.addEventListener('mousedown', (event) => event.preventDefault());
            option.addEventListener('click', () => choose(index));
            option.addEventListener('mousemove', () => { if (active !== index) setActive(index); });
            list.append(option);
        });
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        setActive(-1);
    }

    function choose(index) {
        const item = items[index];
        if (item) window.location.assign(item.url);
        else form.requestSubmit();
    }

    async function load() {
        const term = input.value.trim();
        controller?.abort();
        if (term.length < 2) {
            items = [];
            close();
            return;
        }
        controller = new AbortController();
        const params = new URLSearchParams({ q: term, tipo: typeSelect?.value || 'all' });
        try {
            const response = await fetch(`/buscar/sugerencias?${params}`, { signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            items = (await response.json()).suggestions || [];
            if (document.activeElement === input && input.value.trim() === term) render(term);
        } catch (error) {
            if (error.name !== 'AbortError') close();
        }
    }

    // Espera a que se deje de tipear un momento antes de preguntarle al servidor.
    const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(load, 180);
    };

    input.addEventListener('input', schedule);
    input.addEventListener('focus', () => { if (input.value.trim().length >= 2) schedule(); });
    typeSelect?.addEventListener('change', () => { if (input.value.trim().length >= 2) { input.focus(); schedule(); } });
    input.addEventListener('blur', () => setTimeout(close, 120));
    input.addEventListener('keydown', (event) => {
        if (list.hidden) return;
        const count = list.querySelectorAll('[role="option"]').length;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((active + 1) % count);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(active <= 0 ? count - 1 : active - 1);
        } else if (event.key === 'Enter' && active >= 0) {
            event.preventDefault();
            choose(active);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            close();
        }
    });
})();
