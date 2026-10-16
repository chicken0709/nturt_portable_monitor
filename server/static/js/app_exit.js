(() => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Exit';
    button.setAttribute('aria-label', 'Exit the portable CAN monitor app');
    Object.assign(button.style, {
        position: 'fixed',
        right: '18px',
        bottom: '18px',
        zIndex: '10000',
        padding: '12px 18px',
        border: '1px solid rgba(255,255,255,.25)',
        borderRadius: '10px',
        background: '#991b1b',
        color: '#fff',
        font: '600 15px system-ui, sans-serif',
        boxShadow: '0 4px 14px rgba(0,0,0,.35)',
        cursor: 'pointer',
    });

    button.addEventListener('click', async () => {
        if (!window.confirm('Close the NTURT Portable CAN Monitor?')) return;

        button.disabled = true;
        button.textContent = 'Closing…';
        try {
            const response = await fetch('/api/app/exit', { method: 'POST' });
            const result = await response.json();
            if (!response.ok || result.status !== 'closing') {
                throw new Error(result.error || 'The app could not be closed.');
            }
            button.textContent = 'App closing…';
        } catch (error) {
            window.alert(error.message || 'The app could not be closed.');
            button.disabled = false;
            button.textContent = 'Exit';
        }
    });

    document.body.appendChild(button);
})();
