function meshApp() {
    return {
        // Map instance
        map: null,
        
        // Panel configuration
        panels: {
            left: {
                visible: false,
                width: 300,
                minWidth: 200,
                maxWidth: 500
            },
            right: {
                visible: false,
                width: 350,
                minWidth: 250,
                maxWidth: 600
            },
            bottom: {
                visible: false,
                height: 200,
                minHeight: 100,
                maxHeight: 400
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
        
        // Initialize app
        init() {
            console.log('Initializing app...');
            this.initMap();
            this.setupEventListeners();
            console.log('App initialized');
        },
        
        // Initialize Leaflet map
        initMap() {
            console.log('Initializing map...');
            this.map = L.map('map').setView([47.5, 19.0], 8);
            
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors'
            }).addTo(this.map);
            
            // Add a sample marker
            L.marker([47.5, 19.0])
                .addTo(this.map)
                .bindPopup('Sample Location')
                .openPopup();
                
            console.log('Map initialized');
        },
        
        // Setup global event listeners
        setupEventListeners() {
            // Handle window resize
            window.addEventListener('resize', () => {
                if (this.map) {
                    this.map.invalidateSize();
                }
            });
            
            // Handle mouse move for resizing
            document.addEventListener('mousemove', (e) => {
                if (this.resizing.active) {
                    this.handleResize(e);
                }
            });
            
            // Handle mouse up for resizing
            document.addEventListener('mouseup', () => {
                this.stopResize();
            });
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
            console.log('Starting resize for panel:', panelName);
            this.resizing.active = true;
            this.resizing.panel = panelName;
            this.resizing.startX = event.clientX;
            this.resizing.startY = event.clientY;
            this.resizing.startWidth = this.panels[panelName].width;
            this.resizing.startHeight = this.panels[panelName].height;
            
            // Prevent text selection during resize
            document.body.style.userSelect = 'none';
            document.body.style.cursor = this.getResizeCursor(panelName);
        },
        
        // Handle panel resizing
        handleResize(event) {
            if (!this.resizing.active) return;
            
            const panel = this.panels[this.resizing.panel];
            
            if (this.resizing.panel === 'left') {
                const newWidth = this.resizing.startWidth + (event.clientX - this.resizing.startX);
                panel.width = Math.max(panel.minWidth, Math.min(panel.maxWidth, newWidth));
            } else if (this.resizing.panel === 'right') {
                const newWidth = this.resizing.startWidth - (event.clientX - this.resizing.startX);
                panel.width = Math.max(panel.minWidth, Math.min(panel.maxWidth, newWidth));
            } else if (this.resizing.panel === 'bottom') {
                const newHeight = this.resizing.startHeight - (event.clientY - this.resizing.startY);
                panel.height = Math.max(panel.minHeight, Math.min(panel.maxHeight, newHeight));
                console.log('Resizing bottom panel to:', panel.height);
            }
            
            // Resize map during resize
            if (this.map) {
                this.map.invalidateSize();
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
        
        // Show modal
        showModal(type, data = {}) {
            // Add modal-open class to body
            document.body.classList.add('modal-open');
            
            switch (type) {
                case 'test':
                    this.modal.title = 'Test Modal';
                    this.modal.content = `
                        <p>This is a test modal to demonstrate the modal system.</p>
                        <p class="mt-2">You can put any content here, including forms, tables, or other interactive elements.</p>
                    `;
                    this.modal.onConfirm = () => {
                        console.log('Modal confirmed');
                        this.closeModal();
                    };
                    break;
                
                case 'node-details':
                    this.modal.title = `Node ${data.id || 'Unknown'}`;
                    this.modal.content = `
                        <div class="space-y-2">
                            <div><strong>ID:</strong> ${data.id || 'N/A'}</div>
                            <div><strong>Name:</strong> ${data.name || 'N/A'}</div>
                            <div><strong>Status:</strong> <span class="${data.online ? 'text-green-600' : 'text-red-600'}">${data.online ? 'Online' : 'Offline'}</span></div>
                            <div><strong>Last Seen:</strong> ${data.lastSeen || 'N/A'}</div>
                        </div>
                    `;
                    this.modal.onConfirm = () => this.closeModal();
                    break;
            }
            
            this.modal.visible = true;
        },
        
        // Close modal
        closeModal() {
            // Remove modal-open class from body
            document.body.classList.remove('modal-open');
            
            this.modal.visible = false;
            this.modal.title = '';
            this.modal.content = '';
            this.modal.onConfirm = () => {};
        }
    };
}
