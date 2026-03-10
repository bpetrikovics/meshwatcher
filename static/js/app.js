// Application configuration
const CONFIG = {
    DEFAULT_MAP_CENTER: [47.5, 19.0],
    DEFAULT_ZOOM: 8,
    // API configuration
    API: {
        DEFAULT_LIMIT: 1000,
        MAX_LIMIT: 5000,
        DEFAULT_INCLUDES: ['positions', 'info'],
        DEFAULT_FILTERS: {
            has_position: true,
            active: false
        },
        // Timing configuration
        MAP_INIT_DELAY: 200, // ms delay before loading nodes
    },
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
        // HTML sanitization helper to prevent XSS attacks
        sanitizeHtml(str) {
            if (str === null || str === undefined) return '';
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        },
        
        // Map instance
        map: null,
        
        // Map state tracking
        isZooming: false,
        
        // Node management
        nodes: {},
        nodeLayer: null,
        networkLayer: null,
        traceLayer: null,
        
        // Performance caching for legend
        cachedRoles: null,
        needsRoleUpdate: true,
        
        // Get cached unique roles for performance
        getUniqueRoles() {
            if (this.needsRoleUpdate || this.cachedRoles === null) {
                this.cachedRoles = new Set(
                    Object.values(this.nodes)
                        .map(node => node.role)
                        .filter(role => role !== null && role !== undefined && role !== '')
                );
                this.needsRoleUpdate = false;
            }
            return this.cachedRoles;
        },
        
        // Convert degrees to compass direction
        getCompassDirection(degrees) {
            const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
            const index = Math.round(degrees / 45) % 8;
            return directions[index];
        },
        
        // Invalidate role cache when nodes change
        invalidateRoleCache() {
            this.needsRoleUpdate = true;
        },
        modal: {
            visible: false,
            title: '',
            content: '',
            onConfirm: () => {}
        },
        loading: {
            nodes: false,
            pagination: false
        },
        resizing: {
            active: false,
            panel: null,
            startX: 0,
            startY: 0,
            startWidth: 0,
            startHeight: 0
        },
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
        mouseMoveHandler: null,
        mouseUpHandler: null,
        
        // Initialize application
        init() {
            console.log('Initializing app...');
            
            // Ensure DOM is ready before initializing map
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => {
                    this.initMap();
                    this.setupEventListeners();
                    this.initializeCommitDisplay();
                    this.setupPageUnloadHandlers();
                    console.log('App initialized after DOM ready');
                });
            } else {
                // DOM is already ready
                this.initMap();
                this.setupEventListeners();
                this.initializeCommitDisplay();
                this.setupPageUnloadHandlers();
                console.log('App initialized immediately');
            }
        },
        
        // Initialize Leaflet map
        initMap(retryCount = 0) {
            try {
                const retryText = retryCount > 0 ? ` (attempt ${retryCount + 1})` : '';
                console.log('Initializing map...' + retryText);
                
                // Check if map container exists
                const mapContainer = document.getElementById('map');
                if (!mapContainer) {
                    console.error('Map container not found - DOM may not be ready');
                    // Retry with limit to prevent infinite loops
                    if (retryCount < 5) {
                        setTimeout(() => this.initMap(retryCount + 1), 100);
                    } else {
                        console.error('Map initialization failed after 5 attempts');
                        this.showError('Map container not found. Please refresh the page.');
                    }
                    return;
                }
                
                // Check if map is already initialized
                if (this.map) {
                    console.log('Map already initialized, skipping...');
                    return;
                }
                
                // Check if Leaflet is available
                if (typeof L === 'undefined') {
                    throw new Error('LEAFLET_NOT_LOADED');
                }
                
                // Initialize map
                this.map = L.map('map', {
                    center: CONFIG.DEFAULT_MAP_CENTER,
                    zoom: CONFIG.DEFAULT_ZOOM,
                    scrollWheelZoom: true  // Re-enable scroll wheel zoom
                });
                
                // Set map as loaded immediately after creation
                this.map._loaded = true;
                
                // Patch the problematic Popup method to prevent null map access
                const originalPopupInit = L.Popup.prototype._animateZoom;
                if (originalPopupInit) {
                    L.Popup.prototype._animateZoom = function() {
                        if (!this._map) {
                            return; // Prevent null map access
                        }
                        return originalPopupInit.call(this);
                    };
                }
                
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    attribution: '© OpenStreetMap contributors',
                    maxZoom: 18
                }).addTo(this.map);
                
                // Initialize layers
                this.nodeLayer = L.layerGroup().addTo(this.map);
                this.networkLayer = L.layerGroup().addTo(this.map);
                this.traceLayer = L.layerGroup().addTo(this.map);
                
                // Add zoom event handlers to prevent popup issues
                this.map.on('zoomstart', () => {
                    this.isZooming = true;
                    // Close all open popups before zoom to prevent errors
                    this.map.closePopup();
                });
                
                this.map.on('zoomend', () => {
                    setTimeout(() => {
                        this.isZooming = false;
                    }, 100); // Delay to ensure zoom animation completes
                });
                
                // Add status legend
                this.addStatusLegend();
                
                console.log('Map initialized successfully');
                
                // Load initial nodes after map is ready
                setTimeout(() => {
                    this.loadInitialNodes();
                }, CONFIG.API.MAP_INIT_DELAY); // Use configurable delay
                
            } catch (error) {
                console.error('Failed to initialize map:', error);
                
                // Handle specific error types
                if (error.message === 'LEAFLET_NOT_LOADED' && retryCount < 2) {
                    console.warn('Leaflet not loaded, will retry...');
                    setTimeout(() => this.initMap(retryCount + 1), 500);
                } else {
                    this.showError('MAP_LOAD_FAILED');
                }
            }
        },
        
        // Setup global event listeners
        setupEventListeners() {
            // Handle window resize
            this.resizeHandler = () => {
                if (this.map && this.map._container && this.map._loaded) {
                    try {
                        this.map.invalidateSize();
                    } catch (error) {
                        console.warn('Map resize failed:', error);
                    }
                }
            };
            window.addEventListener('resize', this.resizeHandler);
            
            // Handle mouse move for resizing
            this.mouseMoveHandler = (e) => {
                if (this.resizing && this.resizing.active) {
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
            console.log('Cleaning up app resources...');
            
            // Remove window event listeners
            if (this.resizeHandler) {
                window.removeEventListener('resize', this.resizeHandler);
                this.resizeHandler = null;
            }
            
            // Remove document event listeners
            if (this.mouseMoveHandler) {
                document.removeEventListener('mousemove', this.mouseMoveHandler);
                this.mouseMoveHandler = null;
            }
            if (this.mouseUpHandler) {
                document.removeEventListener('mouseup', this.mouseUpHandler);
                this.mouseUpHandler = null;
            }
            
            // Clean up map resources
            if (this.map) {
                // Remove all layers
                if (this.nodeLayer) {
                    this.nodeLayer.clearLayers();
                    this.map.removeLayer(this.nodeLayer);
                }
                if (this.networkLayer) {
                    this.networkLayer.clearLayers();
                    this.map.removeLayer(this.networkLayer);
                }
                if (this.traceLayer) {
                    this.traceLayer.clearLayers();
                    this.map.removeLayer(this.traceLayer);
                }
                
                // Remove map from container
                this.map.remove();
                this.map = null;
            }
            
            // Clear node references
            this.nodes = {};
            
            // Clear modal state
            this.modal.visible = false;
            this.modal.title = '';
            this.modal.content = '';
            this.modal.onConfirm = () => {};
            
            // Reset resizing state
            this.resizing.active = false;
            this.resizing.panel = null;
            
            console.log('App cleanup completed');
        },
        
        // Setup page unload handlers for proper cleanup
        setupPageUnloadHandlers() {
            // Handle page unload
            const handlePageUnload = () => {
                this.cleanup();
            };
            
            // Handle before unload (when user navigates away)
            const handleBeforeUnload = () => {
                this.cleanup();
            };
            
            // Add event listeners for cleanup
            window.addEventListener('beforeunload', handleBeforeUnload);
            window.addEventListener('unload', handlePageUnload);
            
            // Also handle visibility change (tab switching)
            const handleVisibilityChange = () => {
                if (document.visibilityState === 'hidden') {
                    // Optional: cleanup when tab becomes hidden
                    // this.cleanup();
                }
            };
            document.addEventListener('visibilitychange', handleVisibilityChange);
            
            // Store cleanup handlers for potential manual removal
            this._cleanupHandlers = {
                handlePageUnload,
                handleBeforeUnload,
                handleVisibilityChange
            };
        },
        
        // Toggle panel visibility
        togglePanel(panelName) {
            this.panels[panelName].visible = !this.panels[panelName].visible;
            
            // Resize map immediately since animations were removed
            if (this.map) {
                this.map.invalidateSize();
            }
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
            
            // Safely access panel dimensions with defaults
            const panel = this.panels[panelName];
            this.resizing.startWidth = panel.width || CONFIG.PANEL_SIZES[panelName]?.default || 300;
            this.resizing.startHeight = panel.height || CONFIG.PANEL_SIZES[panelName]?.default || 200;
            
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
            if (!this.resizing || !this.resizing.active) return;
            
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
            if (this.map && this.map._container && this.map._loaded) {
                try {
                    this.map.invalidateSize();
                } catch (error) {
                    console.warn('Map resize during panel resize failed:', error);
                }
            }
            
            // Prevent default touch behavior
            if (event.preventDefault) {
                event.preventDefault();
            }
        },
        
        // Stop resizing
        stopResize() {
            if (!this.resizing) return;
            
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
        showError(errorType) {
            const errorMessages = {
                'MAP_LOAD_FAILED': 'Map library failed to load. Please check your internet connection and refresh the page.',
                'MAP_INIT_FAILED': 'Map initialization failed. Please refresh the page.',
                'NODE_LOAD_FAILED': 'Failed to load node data. Please refresh the page.',
                'MODAL_FAILED': 'Failed to open modal. Please try again.'
            };
            
            const message = errorMessages[errorType] || 'An unexpected error occurred.';
            console.error(`${errorType}: ${message}`);
            
            // Show user-facing error for critical issues
            if (errorMessages[errorType]) {
                const errorDiv = document.createElement('div');
                errorDiv.className = 'error-message';
                errorDiv.innerHTML = `
                    ${message}
                    <span class="close-btn" onclick="this.parentElement.remove()">×</span>
                `;
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
                'node-details': () => {
                    // Sanitize user data to prevent XSS
                    const sanitizeHtml = (str) => {
                        const div = document.createElement('div');
                        div.textContent = str || 'N/A';
                        return div.innerHTML;
                    };
                    
                    return {
                        title: `Node ${sanitizeHtml(data.id)}`,
                        content: `
                            <div class="space-y-2">
                                <div><strong>ID:</strong> ${sanitizeHtml(data.id)}</div>
                                <div><strong>Long Name:</strong> ${sanitizeHtml(data.long_name || data.name || 'N/A')}</div>
                                <div><strong>Short Name:</strong> ${sanitizeHtml(data.short_name || 'N/A')}</div>
                                <div><strong>Status:</strong> <span class="${data.online ? 'text-green-600' : 'text-red-600'}">${data.online ? 'Online' : 'Offline'}</span></div>
                                <div><strong>Last Seen:</strong> ${sanitizeHtml(data.lastSeen)}</div>
                            </div>
                        `,
                        onConfirm: () => this.closeModal()
                    };
                }
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
                this.showError('MODAL_FAILED');
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
        },
        
        // Initialize commit display
        initializeCommitDisplay() {
            const commitElement = document.getElementById('commit-sha');
            if (!commitElement) return;
            
            // Validate config structure
            if (!window.APP_CONFIG || typeof window.APP_CONFIG.GIT_COMMIT !== 'string') {
                commitElement.textContent = 'unknown version';
                return;
            }
            
            const gitCommit = window.APP_CONFIG.GIT_COMMIT.trim();
            if (!gitCommit) {
                commitElement.textContent = 'unknown version';
                return;
            }
            
            // Configuration: length of short SHA (standard git default is 7)
            const SHORT_SHA_LENGTH = 7;
            
            // Check if it looks like a git SHA (hexadecimal string)
            const isGitSha = /^[a-fA-F0-9]+$/.test(gitCommit);
            
            if (isGitSha) {
                // Shorten to specified length
                const shortCommit = gitCommit.length >= SHORT_SHA_LENGTH 
                    ? gitCommit.substring(0, SHORT_SHA_LENGTH) 
                    : gitCommit;
                commitElement.textContent = shortCommit;
                commitElement.title = `Full commit: ${gitCommit}`;
            } else {
                // Not a SHA, show as-is with "unknown version" fallback
                commitElement.textContent = gitCommit === '(unknown version)' ? 'unknown version' : gitCommit;
                commitElement.title = gitCommit;
            }
        },
        
        // API utility functions
        buildApiUrl(params = {}) {
            const queryParams = new URLSearchParams();
            
            // Add includes
            const includes = params.includes || CONFIG.API.DEFAULT_INCLUDES;
            queryParams.append('include', includes.join(','));
            
            // Add filters
            const filters = { ...CONFIG.API.DEFAULT_FILTERS, ...params.filters };
            Object.entries(filters).forEach(([key, value]) => {
                if (value !== null && value !== undefined) {
                    queryParams.append(key, value.toString());
                }
            });
            
            // Add pagination
            if (params.limit) {
                queryParams.append('limit', Math.min(params.limit, CONFIG.API.MAX_LIMIT));
            } else {
                queryParams.append('limit', CONFIG.API.DEFAULT_LIMIT);
            }
            
            if (params.offset) {
                queryParams.append('offset', params.offset);
            }
            
            return `/api/nodes?${queryParams.toString()}`;
        },
        async loadInitialNodes() {
            try {
                this.loading.nodes = true;
                console.log('Loading initial nodes...');
                const url = this.buildApiUrl();
                const response = await fetch(url);
                const data = await response.json();
                
                console.log(`Loaded ${data.nodes.length} nodes`);
                
                // Add nodes to map
                data.nodes.forEach(node => {
                    this.addNodeToMap(node);
                });
                
                // Handle pagination iteratively to prevent stack overflow
                await this.loadAllPages(data);
                
                // Fit map to show all nodes
                if (this.nodeLayer.getLayers().length > 0 && this.map && this.map._loaded) {
                    try {
                        const group = L.featureGroup(this.nodeLayer.getLayers());
                        this.map.fitBounds(group.getBounds().pad(0.1));
                    } catch (error) {
                        console.warn('Failed to fit map bounds:', error);
                    }
                }
                
            } catch (error) {
                console.error('Failed to load initial nodes:', error);
                this.showError('NODE_LOAD_FAILED');
            } finally {
                this.loading.nodes = false;
            }
        },
        
        async loadAllPages(initialData) {
            let offset = initialData.pagination.next_offset;
            let hasMore = initialData.pagination.has_more;
            let pageCount = 1;
            const maxPages = 50; // Prevent infinite loops
            
            while (hasMore && pageCount < maxPages) {
                console.log(`Loading page ${pageCount + 1}...`);
                
                const url = this.buildApiUrl({ offset });
                const response = await fetch(url);
                const data = await response.json();
                
                data.nodes.forEach(node => {
                    this.addNodeToMap(node);
                });
                
                hasMore = data.pagination.has_more;
                offset = data.pagination.next_offset;
                pageCount++;
                
                // Small delay to prevent overwhelming the server
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            if (pageCount >= maxPages) {
                console.warn('Reached maximum page limit, stopping pagination');
            } else {
                console.log(`Loaded ${pageCount} pages total`);
            }
        },
        
        async loadMoreNodes(offset) {
            try {
                this.loading.pagination = true;
                const url = this.buildApiUrl({ offset });
                const response = await fetch(url);
                const data = await response.json();
                
                data.nodes.forEach(node => {
                    this.addNodeToMap(node);
                });
                
                // Continue pagination if needed
                if (data.pagination.has_more) {
                    await this.loadMoreNodes(data.pagination.next_offset);
                }
                
            } catch (error) {
                console.error('Failed to load more nodes:', error);
                this.showError('NODE_LOAD_FAILED');
            } finally {
                this.loading.pagination = false;
            }
        },
        
        // Role-based icon mapping
        getIconForRole(role) {
            const roleIcons = {
                'CLIENT': 'mdi-radio-tower',
                'CLIENT_MUTE': 'mdi-volume-mute',
                'CLIENT_BASE': 'mdi-home',
                'ROUTER': 'mdi-hub-outline',
                'ROUTER_LATE': 'mdi-hubspot',
                'REPEATER': 'mdi-repeat',
                'SENSOR': 'mdi-thermometer',
                'TRACKER': 'mdi-crosshairs-gps'
            };
            return roleIcons[role] || 'mdi-help-circle';
        },

        addNodeToMap(node) {
            // Check if map is ready
            if (!this.map || !this.map._loaded) {
                console.warn('Map not fully initialized yet, skipping node addition');
                return;
            }
            
            if (!node.position || !this.nodeLayer) {
                console.warn('Invalid node data or node layer not ready');
                return;
            }
            
            try {
                // Store node data
                this.nodes[node.id] = node;
                this.invalidateRoleCache(); // Invalidate cache when node is added
                
                // Determine status and styling
                const status = node.info?.status || 'inactive';
                const statusClass = this.getStatusClass(status);
                const timeAgo = this.getTimeAgoText(node.info?.last_seen_hours_ago);
                const role = this.sanitizeHtml(node.role || 'Unknown');
                const roleIcon = this.getIconForRole(role);
                const safeName = this.sanitizeHtml(node.long_name || node.id);
                const safeStatusLabel = this.sanitizeHtml(this.getStatusLabel(status));
                
                // Check for movement and heading
                const hasSpeed = node.position && node.position.ground_speed && node.position.ground_speed > 0;
                const hasHeading = node.position && node.position.heading != null;
                const shouldShowDirection = hasSpeed && hasHeading;
                const rotation = shouldShowDirection ? node.position.heading : 0;
                
                // Create custom node marker with optional directional shape
                const iconHtml = shouldShowDirection 
                    ? `<div class="node-icon directional-parent" 
                          title="${safeName}\nRole: ${role}\nStatus: ${safeStatusLabel}\nLast seen: ${timeAgo}">
                         <div class="directional-indicator ${statusClass}" style="transform: rotate(${rotation}deg);">
                            <i class="mdi ${roleIcon}"></i>
                         </div>
                       </div>`
                    : `<div class="node-icon ${statusClass}" 
                          title="${safeName}\nRole: ${role}\nStatus: ${safeStatusLabel}\nLast seen: ${timeAgo}">
                         <i class="mdi ${roleIcon}"></i>
                       </div>`;
                
                const icon = L.divIcon({
                    className: 'node-marker',
                    html: iconHtml,
                    iconSize: shouldShowDirection ? [30, 30] : [24, 24],
                    iconAnchor: shouldShowDirection ? [15, 15] : [12, 12]
                });
                
                const marker = L.marker([node.position.latitude, node.position.longitude], { icon })
                    .bindPopup(() => {
                        try {
                            // Prevent popup during zoom animations
                            if (this.isZooming || !this.map || !this.map._loaded) {
                                return '<div class="node-popup"><p>Loading...</p></div>';
                            }
                            return this.createNodePopup(node);
                        } catch (error) {
                            // Catch the Popup.js error and provide fallback
                            console.warn('Popup error caught:', error);
                            return '<div class="node-popup"><p>Node information temporarily unavailable</p></div>';
                        }
                    })
                    .addTo(this.nodeLayer);
                
                // Store marker reference
                node.marker = marker;
            } catch (error) {
                console.error('Failed to add node to map:', error);
            }
        },
        
        createNodePopup(node) {
            const info = node.info || {};
            const position = node.position || {};
            const role = this.sanitizeHtml(node.role || 'Unknown');
            const roleIcon = this.getIconForRole(role);
            const safeName = this.sanitizeHtml(node.long_name || node.id);
            const safeShortName = this.sanitizeHtml(node.short_name || '');
            const safeHwModel = this.sanitizeHtml(node.hw_model || '');
            const safeId = this.sanitizeHtml(node.id);
            
            return `
                <div class="node-popup">
                    <h4>${safeName}</h4>
                    <div class="node-role-section">
                        <i class="mdi ${roleIcon} role-icon"></i>
                        <span class="role-badge">${role}</span>
                        ${safeHwModel ? `<span class="hw-model">${safeHwModel}</span>` : ''}
                    </div>
                    <div class="node-info">
                        <p><strong>ID:</strong> ${safeId}</p>
                        ${safeShortName ? `<p><strong>Short Name:</strong> ${safeShortName}</p>` : ''}
                        <p><strong>Status:</strong> <span class="status-badge ${this.getStatusClass(info.status)}">${this.getStatusLabel(info.status)}</span></p>
                        ${position.ground_speed ? `<p><strong>Ground Speed:</strong> ${position.ground_speed} m/s</p>` : ''}
                        ${position.heading != null ? `<p><strong>Heading:</strong> ${position.heading.toFixed(1)}° (${this.getCompassDirection(position.heading)})</p>` : ''}
                        ${info.last_seen_hours_ago !== null ? `<p><strong>Last seen:</strong> ${this.getTimeAgoText(info.last_seen_hours_ago)}</p>` : ''}
                        ${position.latitude ? `<p><strong>Position:</strong> ${position.latitude.toFixed(6)}, ${position.longitude.toFixed(6)}</p>` : ''}
                        ${position.altitude ? `<p><strong>Altitude:</strong> ${position.altitude}m</p>` : ''}
                        ${info.is_unmessagable ? '<p><em>Node is unmessagable</em></p>' : ''}
                    </div>
                </div>
            `;
        },
        
        updateNodePosition(nodeId, position) {
            const node = this.nodes[nodeId];
            if (!node || !node.marker || !this.map || !this.map._loaded) {
                console.warn('Cannot update node position: map, node, or marker not available');
                return;
            }
            
            try {
                // Update node position data
                node.position = position;
                
                // Animate marker to new position
                const newLatLng = L.latLng(position.latitude, position.longitude);
                node.marker.setLatLng(newLatLng);
                
                // Update popup
                node.marker.setPopupContent(this.createNodePopup(node));
            } catch (error) {
                console.error('Failed to update node position:', error);
            }
        },
        
        // Status legend functions
        addStatusLegend() {
            const statusLegend = L.control({ position: 'bottomleft' });
            
            statusLegend.onAdd = (map) => {
                const div = L.DomUtil.create('div', 'status-legend');
                const thresholds = window.APP_CONFIG || {
                    STATUS_CURRENTLY_ACTIVE_HOURS: 24,
                    STATUS_RECENTLY_ACTIVE_HOURS: 72
                };
                
                // Use cached roles for better performance
                const uniqueRoles = this.getUniqueRoles();
                
                div.innerHTML = `
                    <div style="font-weight: bold; margin-bottom: 8px;">Node Status</div>
                    <div class="legend-item">
                        <div class="node-icon currently-active"></div>
                        Currently Active (≤${thresholds.STATUS_CURRENTLY_ACTIVE_HOURS}h)
                    </div>
                    <div class="legend-item">
                        <div class="node-icon recently-active"></div>
                        Recently Active (≤${thresholds.STATUS_RECENTLY_ACTIVE_HOURS}h)
                    </div>
                    <div class="legend-item">
                        <div class="node-icon inactive"></div>
                        Inactive (>${thresholds.STATUS_RECENTLY_ACTIVE_HOURS}h)
                    </div>
                    ${uniqueRoles.size > 0 ? `
                        <div class="legend-section-title">Device Roles</div>
                        ${Array.from(uniqueRoles).sort().map(role => `
                            <div class="legend-item">
                                <div class="node-icon" style="background: #f9fafb; border: 2px solid #d1d5db; color: #374151;">
                                    <i class="mdi ${this.getIconForRole(role)}" style="font-size: 12px;"></i>
                                </div>
                                ${this.sanitizeHtml(role)}
                            </div>
                        `).join('')}
                    ` : ''}
                `;
                return div;
            };
            
            statusLegend.addTo(this.map);
        },
        
        // Status helper functions
        getStatusClass(status) {
            switch (status) {
                case 'currently_active':
                    return 'currently-active';
                case 'recently_active':
                    return 'recently-active';
                case 'inactive':
                default:
                    return 'inactive';
            }
        },
        
        getStatusLabel(status) {
            switch (status) {
                case 'currently_active':
                    return 'Currently Active';
                case 'recently_active':
                    return 'Recently Active';
                case 'inactive':
                default:
                    return 'Inactive';
            }
        },
        
        getTimeAgoText(hoursAgo) {
            if (hoursAgo === null || hoursAgo === undefined) {
                return 'Never seen';
            }
            
            if (hoursAgo < 1) {
                return 'Less than 1 hour ago';
            } else if (hoursAgo < 24) {
                return `${Math.round(hoursAgo)} hours ago`;
            } else {
                const days = Math.round(hoursAgo / 24);
                return `${days} day${days === 1 ? '' : 's'} ago`;
            }
        },
        
        removeNodeFromMap(nodeId) {
            try {
                const node = this.nodes[nodeId];
                if (!node || !node.marker) {
                    console.warn('Node or marker not found for removal');
                    return;
                }
                
                this.nodeLayer.removeLayer(node.marker);
                delete this.nodes[nodeId];
            } catch (error) {
                console.error('Failed to remove node from map:', error);
            }
        },
        
        // Manual cleanup method for testing or forced cleanup
        forceCleanup() {
            console.log('Force cleaning up app resources...');
            
            // Remove cleanup handlers first to prevent double cleanup
            if (this._cleanupHandlers) {
                window.removeEventListener('beforeunload', this._cleanupHandlers.handleBeforeUnload);
                window.removeEventListener('unload', this._cleanupHandlers.handlePageUnload);
                document.removeEventListener('visibilitychange', this._cleanupHandlers.handleVisibilityChange);
                this._cleanupHandlers = null;
            }
            
            // Perform full cleanup
            this.cleanup();
        }
    };
}
