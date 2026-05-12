document.addEventListener('DOMContentLoaded', () => {
    /* === Scroll Animations (Intersection Observer) === */
    const faders = document.querySelectorAll('.fade-in, .fade-in-up, .fade-in-left, .fade-in-right');

    const appearOptions = {
        threshold: 0.1,
        rootMargin: "0px 0px -50px 0px"
    };

    const appearOnScroll = new IntersectionObserver(function(entries, observer) {
        entries.forEach(entry => {
            if (!entry.isIntersecting) {
                return;
            } else {
                const delay = entry.target.getAttribute('data-delay');
                if (delay) {
                    entry.target.style.transitionDelay = delay;
                }
                entry.target.classList.add('appear');
            }
        });
    }, appearOptions);

    faders.forEach(fader => {
        appearOnScroll.observe(fader);
    });

    /* === Animated Cyber Colors === */
    let currentHue = 160; // Start at cyan
    
    function animateColors() {
        currentHue = (currentHue + 0.3) % 360; 
        document.documentElement.style.setProperty('--accent-color', `hsl(${currentHue}, 100%, 50%)`);
        document.documentElement.style.setProperty('--accent-glow', `hsla(${currentHue}, 100%, 50%, 0.4)`);
        requestAnimationFrame(animateColors);
    }
    
    requestAnimationFrame(animateColors);
});
