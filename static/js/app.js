// Configuration object
const CONFIG = {
    DEFAULT_MAP_CENTER: [47.5, 19.0],
    DEFAULT_ZOOM: 8,
    PANEL_SIZES: {
        left: { default: 300, min: 200, max: 500 },
        right: { default: 350, min: 250, max: 600 },
        bottom: { default: 200, min: 100, max: 400 }
    },
    Z_INDEX: {
        dropdown: 1000,
        sticky: 1020,
        fixed: 1030,
        modalBackdrop: 1040,
        modal: 1050,
        popover: 1060,
        tooltip: 1070
    }
};

function meshApp() {
    return {
        // Map instance
        map: null,
        
        // Panel configuration
        panels: {
            left: {
                visible: false,
                width: CONFIG.PANEL_SIZES.left.default,
                minWidth: CONFIG.PANEL_SIZES.left.min,
                maxWidth: CONFIG.PANEL_SIZES.left.max
            },
            right: {
                visible: false,
                width: CONFIG.PANEL_SIZES.right.default,
                minWidth: CONFIG.PANEL_SIZES.right.min,
                maxWidth: CONFIG.PANEL_SIZES.right.max
            },
            bottom: {
                visible: false,
                height: CONFIG.PANEL_SIZES.bottom.default,
                minHeight: CONFIG.PANEL_SIZES.bottom.min,
                maxHeight: CONFIG.PANEL_SIZES.bottom.max
            }
        },
        
        // Modal configuration
        modal: {
            visible: false,
            title: '',
            content: '',
            onConfirm: () => {}
        },
        
        // Resize state
        resizing: {
            active: false,
            panel: null,
            startX: 0,
            startY: 0,
            startWidth: 0,
            startHeight: 0
        },
        
        // Event handlers for cleanup
        resizeHandler: null,
        mouseMoveHandler: null,
        mouseUpHandler: null,
        
        // Initialize app
        init() {
            console.log('Initializing app...');
            
            // Ensure DOM is ready before initializing map
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => {
                    this.initMap();
                    this.setupEventListeners();
                    console.log('App initialized after DOM ready');
                });
            } else {
                // DOM is already ready
                this.initMap();
                this.setupEventListeners();
                console.log('App initialized immediately');
            }
        },
        
        // Initialize Leaflet map
        initMap() {
            try {
                console.log('Initializing map...');
                
                // Check if map container exists
                const mapContainer = document.getElementById('map');
                if (!mapContainer) {
                    console.error('Map container not found - DOM may not be ready');
                    // Don't throw error, just log and retry later
                    setTimeout(() => this.initMap(), 100);
                    return;
                }
                
                // Check if map is already initialized
                if (this.map) {
                    console.log('Map already initialized, skipping...');
                    return;
                }
                
                // Check if Leaflet is available
                if (typeof L === 'undefined') {
                    throw new Error('Leaflet library not loaded');
                }
                
                this.map = L.map('map').setView(CONFIG.DEFAULT_MAP_CENTER, CONFIG.DEFAULT_ZOOM);
                
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    attribution: '© OpenStreetMap contributors',
                    maxZoom: 18
                }).addTo(this.map);
                
                // Add a sample marker
                L.marker(CONFIG.DEFAULT_MAP_CENTER)
                    .addTo(this.map)
                    .bindPopup('Sample Location')
                    .openPopup();
                    
                console.log('Map initialized successfully');
            } catch (error) {
                console.error('Failed to initialize map:', error);
                // Only show error for critical failures, not DOM timing issues
                if (error.message.includes('Leaflet library not loaded')) {
                    this.showError('Map initialization failed. Please check your internet connection and refresh the page.');
                } else {
                    console.warn('Map initialization issue, will retry...');
                    // Retry once after a short delay
                    setTimeout(() => this.initMap(), 500);
                }
            }
        },
        
        // Setup global event listeners
        setupEventListeners() {
            // Handle window resize
            this.resizeHandler = () => {
                if (this.map) {
                    this.map.invalidateSize();
                }
            };
            window.addEventListener('resize', this.resizeHandler);
            
            // Handle mouse move for resizing
            this.mouseMoveHandler = (e) => {
                if (this.resizing.active) {
                    this.handleResize(e);
                }
            };
            document.addEventListener('mousemove', this.mouseMoveHandler);
            
            // Handle mouse up for resizing
            this.mouseUpHandler = () => {
                this.stopResize();
            };
            document.addEventListener('mouseup', this.mouseUpHandler);
        },
        
        // Cleanup event listeners
        cleanup() {
            if (this.resizeHandler) {
                window.removeEventListener('resize', this.resizeHandler);
            }
            if (this.mouseMoveHandler) {
                document.removeEventListener('mousemove', this.mouseMoveHandler);
            }
            if (this.mouseUpHandler) {
                document.removeEventListener('mouseup', this.mouseUpHandler);
            }
        },
        
        // Toggle panel visibility
        togglePanel(panelName) {
            this.panels[panelName].visible = !this.panels[panelName].visible;
            
            // Resize map after panel animation
            setTimeout(() => {
                if (this.map) {
                    this.map.invalidateSize();
                }
            }, 300);
        },
        
        // Start resizing a panel
        startResize(panelName, event) {
            // Input validation
            if (!this.panels[panelName]) {
                console.warn(`Invalid panel: ${panelName}`);
                return;
            }
            
            if (this.resizing.active) {
                console.warn('Resize already in progress');
                return;
            }
            
            // Handle both mouse and touch events
            const touch = event.touches?.[0] || event;
            if (!touch || typeof touch.clientX === 'undefined') {
                console.warn('Invalid event coordinates');
                return;
            }
            
            console.log('Starting resize for panel:', panelName);
            this.resizing.active = true;
            this.resizing.panel = panelName;
            this.resizing.startX = touch.clientX;
            this.resizing.startY = touch.clientY;
            this.resizing.startWidth = this.panels[panelName].width;
            this.resizing.startHeight = this.panels[panelName].height;
            
            // Prevent text selection during resize
            document.body.style.userSelect = 'none';
            document.body.style.cursor = this.getResizeCursor(panelName);
            
            // Prevent default touch behavior
            if (event.preventDefault) {
                event.preventDefault();
            }
        },
        
        // Handle panel resizing
        handleResize(event) {
            if (!this.resizing.active) return;
            
            // Handle both mouse and touch events
            const touch = event.touches?.[0] || event;
            if (!touch || typeof touch.clientX === 'undefined') return;
            
            const panel = this.panels[this.resizing.panel];
            
            if (this.resizing.panel === 'left') {
                const newWidth = this.resizing.startWidth + (touch.clientX - this.resizing.startX);
                panel.width = Math.max(panel.minWidth, Math.min(panel.maxWidth, newWidth));
            } else if (this.resizing.panel === 'right') {
                const newWidth = this.resizing.startWidth - (touch.clientX - this.resizing.startX);
                panel.width = Math.max(panel.minWidth, Math.min(panel.maxWidth, newWidth));
            } else if (this.resizing.panel === 'bottom') {
                const newHeight = this.resizing.startHeight - (touch.clientY - this.resizing.startY);
                panel.height = Math.max(panel.minHeight, Math.min(panel.maxHeight, newHeight));
                console.log('Resizing bottom panel to:', panel.height);
            }
            
            // Resize map during resize
            if (this.map) {
                this.map.invalidateSize();
            }
            
            // Prevent default touch behavior
            if (event.preventDefault) {
                event.preventDefault();
            }
        },
        
        // Stop resizing
        stopResize() {
            this.resizing.active = false;
            this.resizing.panel = null;
            
            // Restore cursor and selection
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
        },
        
        // Get resize cursor for panel
        getResizeCursor(panelName) {
            switch (panelName) {
                case 'left':
                case 'right':
                    return 'col-resize';
                case 'bottom':
                    return 'row-resize';
                default:
                    return 'default';
            }
        },
        
        // Show error message
        showError(message) {
            console.error(message);
            // Only show user-facing errors for critical issues
            if (message.includes('internet connection') || message.includes('refresh the page')) {
                // Could integrate with a toast notification system here
                // For now, use a less intrusive approach
                const errorDiv = document.createElement('div');
                errorDiv.className = 'fixed top-20 right-4 bg-red-500 text-white px-4 py-2 rounded shadow-lg z-50';
                errorDiv.textContent = message;
                document.body.appendChild(errorDiv);
                
                // Auto-remove after 5 seconds
                setTimeout(() => {
                    if (errorDiv.parentNode) {
                        errorDiv.parentNode.removeChild(errorDiv);
                    }
                }, 5000);
            }
        },
        
        // Get modal configuration
        getModalConfig(type, data) {
            const configs = {
                test: () => ({
                    title: 'Test Modal',
                    content: `
                        <p>This is a test modal to demonstrate the modal system.</p>
                        <p class="mt-2">You can put any content here, including forms, tables, or other interactive elements.</p>
                    `,
                    onConfirm: () => {
                        console.log('Modal confirmed');
                        this.closeModal();
                    }
                }),
                'node-details': () => ({
                    title: `Node ${data.id || 'Unknown'}`,
                    content: `
                        <div class="space-y-2">
                            <div><strong>ID:</strong> ${data.id || 'N/A'}</div>
                            <div><strong>Name:</strong> ${data.name || 'N/A'}</div>
                            <div><strong>Status:</strong> <span class="${data.online ? 'text-green-600' : 'text-red-600'}">${data.online ? 'Online' : 'Offline'}</span></div>
                            <div><strong>Last Seen:</strong> ${data.lastSeen || 'N/A'}</div>
                        </div>
                    `,
                    onConfirm: () => this.closeModal()
                })
            };
            
            return configs[type]?.() || this.getDefaultModalConfig();
        },
        
        // Get default modal configuration
        getDefaultModalConfig() {
            return {
                title: 'Unknown Modal',
                content: '<p>This modal type is not recognized.</p>',
                onConfirm: () => this.closeModal()
            };
        },
        
        // Show modal
        showModal(type, data = {}) {
            try {
                // Add modal-open class to body
                document.body.classList.add('modal-open');
                
                const modalConfig = this.getModalConfig(type, data);
                Object.assign(this.modal, modalConfig);
                this.modal.visible = true;
            } catch (error) {
                console.error('Failed to show modal:', error);
                this.showError('Failed to open modal');
            }
        },
        
        // Close modal
        closeModal() {
            try {
                // Remove modal-open class from body
                document.body.classList.remove('modal-open');
                
                this.modal.visible = false;
                this.modal.title = '';
                this.modal.content = '';
                this.modal.onConfirm = () => {};
            } catch (error) {
                console.error('Failed to close modal:', error);
            }
        }
    };
}
