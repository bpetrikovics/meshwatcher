// Application configuration
const CONFIG = {
    DEFAULT_MAP_CENTER: [47.5, 19.0],
    DEFAULT_ZOOM: 8,
    API: {
        DEFAULT_LIMIT: 1000,
        MAX_LIMIT: 5000,
        DEFAULT_INCLUDES: ['positions', 'info'],
        DEFAULT_FILTERS: {
            has_position: true,
            active: false
        },
        MAP_INIT_DELAY: 200,  // ms delay before loading nodes
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
        // HTML sanitization to prevent XSS
        sanitizeHtml(str) {
            if (str === null || str === undefined) return '';
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        },
        
        // Map instance
        map: null,
        
        // Map state
        isZooming: false,
        
        // Node management
        nodes: {},
        nodeLayer: null,
        networkLayer: null,
        traceLayer: null,
        
        // Performance caching
        cachedRoles: null,
        needsRoleUpdate: true,
        
        // Get cached unique roles
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
        // Clustering control
        clusteringRadius: 5, // Default value, will be updated from config
        clusteringUpdateTimeout: null,
        mouseMoveHandler: null,
        mouseUpHandler: null,
        
        // Initialize application
        init() {
            console.log('Initializing app...');
            
            // Initialize clustering radius from config
            const config = window.APP_CONFIG || {};
            this.clusteringRadius = config.CLUSTERING_RADIUS || 5;
            
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => {
                    this.initMap();
                    this.setupEventListeners();
                    this.initializeCommitDisplay();
                    this.setupPageUnloadHandlers();
                    console.log('App initialized after DOM ready');
                });
            } else {
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
                
                const mapContainer = document.getElementById('map');
                if (!mapContainer) {
                    console.error('Map container not found - DOM may not be ready');
                    if (retryCount < 5) {
                        setTimeout(() => this.initMap(retryCount + 1), 100);
                    } else {
                        console.error('Map initialization failed after 5 attempts');
                        this.showError('Map container not found. Please refresh the page.');
                    }
                    return;
                }
                
                if (this.map) {
                    console.log('Map already initialized, skipping...');
                    return;
                }
                
                if (typeof L === 'undefined') {
                    throw new Error('LEAFLET_NOT_LOADED');
                }
                
                this.map = L.map('map', {
                    center: CONFIG.DEFAULT_MAP_CENTER,
                    zoom: CONFIG.DEFAULT_ZOOM,
                    scrollWheelZoom: true
                });
                
                this.map._loaded = true;
                
                // Leaflet Popup has a bug where _animateZoom can be called after popup is removed
                // This causes "Cannot read properties of null (reading '_map')" errors during zoom
                // Patching prevents crashes when popups are closed during zoom animations
                const originalPopupInit = L.Popup.prototype._animateZoom;
                if (originalPopupInit) {
                    L.Popup.prototype._animateZoom = function() {
                        if (!this._map) return;
                        return originalPopupInit.call(this);
                    };
                }
                
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    attribution: '© OpenStreetMap contributors',
                    maxZoom: 18
                }).addTo(this.map);
                
                // Initialize layers
                this.initializeNodeLayer();
                this.networkLayer = L.layerGroup().addTo(this.map);
                this.traceLayer = L.layerGroup().addTo(this.map);
                
                // Add zoom event handlers
                this.map.on('zoomstart', () => {
                    this.isZooming = true;
                    // Close popups during zoom to prevent "Cannot read properties of null" errors
                    // Leaflet popups can crash if they try to update while the map is zooming
                    this.map.closePopup();
                });
                
                this.map.on('zoomend', () => {
                    this.isZooming = false;
                    // Prevent popup creation during zoom animations
                    // Popups created during zoom can have incorrect positioning
                });
                
                // disable legend for now
                // this.addStatusLegend();
                
                console.log('Map initialized successfully');
                
                setTimeout(() => {
                    this.loadInitialNodes();
                }, CONFIG.API.MAP_INIT_DELAY);
                // Delay node loading to ensure map is fully rendered
                // Loading nodes too early can cause positioning issues and performance problems
                
            } catch (error) {
                console.error('Failed to initialize map:', error);
                
                if (error.message === 'LEAFLET_NOT_LOADED' && retryCount < 2) {
                    console.warn('Leaflet not loaded, will retry...');
                    setTimeout(() => this.initMap(retryCount + 1), 500);
                } else {
                    this.showError('MAP_LOAD_FAILED');
                }
            }
        },
        
        // Initialize node layer with clustering
        initializeNodeLayer() {
            console.log('Initializing node layer with clustering approach');
            
            const config = window.APP_CONFIG || {};
            const clusteringRadius = config.CLUSTERING_RADIUS || 0;
            
            console.log(`Clustering radius: ${clusteringRadius}px (${clusteringRadius === 0 ? 'spiderfying only' : 'clustering enabled'})`);
            
            this.nodeLayer = L.markerClusterGroup({ 
                maxClusterRadius: clusteringRadius,  // 0 = spiderfying only, >0 = clustering
                spiderfyOnMaxZoom: true,
                zoomToBoundsOnClick: true,
                iconCreateFunction: this.createClusterIcon.bind(this),
                spiderfyDistanceMultiplier: 1.2,
                maxSpiderfySizeMultiplier: 1.5
            });
            
            this.nodeLayer.addTo(this.map);
        },

        // Update clustering radius from slider
        updateClusteringRadius() {
            // Clear any pending update
            if (this.clusteringUpdateTimeout) {
                clearTimeout(this.clusteringUpdateTimeout);
            }
            
            // Debounce updates to avoid excessive recreation during dragging
            this.clusteringUpdateTimeout = setTimeout(() => {
                console.log(`Updating clustering radius to: ${this.clusteringRadius}px`);
                this.recreateNodeLayer();
            }, 100);
        },

        // Recreate node layer with new clustering radius
        recreateNodeLayer() {
            if (!this.map || !this.nodeLayer) return;
            
            // Store current markers
            const currentMarkers = [];
            this.nodeLayer.eachLayer((layer) => {
                currentMarkers.push(layer);
            });
            
            // Remove old layer
            this.map.removeLayer(this.nodeLayer);
            
            // Create new layer with updated radius
            this.nodeLayer = L.markerClusterGroup({ 
                maxClusterRadius: parseInt(this.clusteringRadius),
                spiderfyOnMaxZoom: true,
                zoomToBoundsOnClick: true,
                iconCreateFunction: this.createClusterIcon.bind(this),
                spiderfyDistanceMultiplier: 1.2,
                maxSpiderfySizeMultiplier: 1.5
            });
            
            // Add markers back to new layer
            currentMarkers.forEach(marker => {
                this.nodeLayer.addLayer(marker);
            });
            
            // Add new layer to map
            this.nodeLayer.addTo(this.map);
        },

        // Create custom cluster icons
        createClusterIcon(cluster) {
            const count = cluster.getChildCount();
            const size = Math.min(30 + Math.min(count * 3, 30), 60);
            
            return L.divIcon({
                html: `
                    <div class="cluster-icon" style="
                        width: ${size}px; 
                        height: ${size}px; 
                        background: linear-gradient(135deg, #2196F3, #1976D2);
                        border: 3px solid white;
                        border-radius: 50%;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                        font-weight: bold;
                        color: white;
                        font-size: ${Math.max(12, size/4)}px;
                    ">
                        ${count}
                    </div>
                `,
                className: 'custom-cluster-marker',
                iconSize: [size, size],
                iconAnchor: [size/2, size/2]
            });
        },

        // Setup global event listeners
        setupEventListeners() {
            // Handle window resize to keep map properly sized
            // Map container can change size when browser window is resized
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
            
            // Track mouse movement for panel resizing functionality
            // Mouse move events update panel dimensions during resize operations
            this.mouseMoveHandler = (e) => {
                if (this.resizing && this.resizing.active) {
                    this.handleResize(e);
                }
            };
            document.addEventListener('mousemove', this.mouseMoveHandler);
            
            // Handle mouse up to end resize operations
            // Mouse up can occur anywhere on document, not just on resize handle
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
            
            // Prevent default touch behavior during resize
            // Touch devices can have conflicting scroll/resize gestures
            if (event.preventDefault) {
                event.preventDefault();
            }
        },
        
        // Stop resizing
        stopResize() {
            if (!this.resizing) return;
            
            this.resizing.active = false;
            this.resizing.panel = null;
            
            // Restore normal cursor and text selection after resize
            // Resize operation disables these for better UX, must restore when done
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
                'node-details': () => {
                    return {
                        title: `Node ${this.sanitizeHtml(data.id)}`,
                        content: `
                            <div class="space-y-2">
                                <div><strong>ID:</strong> ${this.sanitizeHtml(data.id)}</div>
                                <div><strong>Long Name:</strong> ${this.sanitizeHtml(data.long_name || data.name || 'N/A')}</div>
                                <div><strong>Short Name:</strong> ${this.sanitizeHtml(data.short_name || 'N/A')}</div>
                                <div><strong>Status:</strong> <span class="${data.online ? 'text-green-600' : 'text-red-600'}">${data.online ? 'Online' : 'Offline'}</span></div>
                                <div><strong>Last packet:</strong> ${this.sanitizeHtml(data.lastSeen)}</div>
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
                        
                        // On mobile, ensure map is properly sized before fitting bounds
                        const isMobile = window.innerWidth <= 768;
                        
                        const fitBoundsWithFallback = (retryCount = 0) => {
                            try {
                                if (this.map && this.map._loaded && this.nodeLayer.getLayers().length > 0) {
                                    const currentGroup = L.featureGroup(this.nodeLayer.getLayers());
                                    const bounds = currentGroup.getBounds();
                                    this.map.fitBounds(bounds.pad(0.1));
                                }
                            } catch (error) {
                                // Retry on mobile up to 3 times with increasing delays
                                if (isMobile && retryCount < 3) {
                                    const delay = 200 * (retryCount + 1); // 200ms, 400ms, 600ms
                                    setTimeout(() => fitBoundsWithFallback(retryCount + 1), delay);
                                }
                            }
                        };
                        
                        if (isMobile) {
                            // Invalidate map size to recalculate container dimensions
                            this.map.invalidateSize();
                            
                            // Start fitting bounds with fallback
                            setTimeout(() => fitBoundsWithFallback(), 100);
                        } else {
                            // Desktop - fit bounds immediately
                            fitBoundsWithFallback();
                        }
                        
                    } catch (error) {
                        console.warn('Failed to setup map bounds fitting:', error);
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
                'TRACKER': 'mdi-crosshairs-gps',
                'TAK': 'mdi-radar',
                'TAK_TRACKER': 'mdi-radar'
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
                const hasSpeed = node.position && node.position.ground_speed_ms !== undefined && node.position.ground_speed_ms !== null && node.position.ground_speed_ms > 0;
                const hasHeading = node.position && node.position.heading !== null && node.position.heading !== undefined;
                const shouldShowDirection = hasSpeed && hasHeading;
                
                // Create custom node marker with optional red border for movement
                const movingClass = shouldShowDirection ? 'moving' : '';
                const iconHtml = `<div class="node-icon ${statusClass} ${movingClass}" 
                                     title="${safeName}\nRole: ${role}\nStatus: ${safeStatusLabel}\nLast packet: ${timeAgo}">
                                    <i class="mdi ${roleIcon}"></i>
                                   </div>`;
                
                const icon = L.divIcon({
                    className: 'node-marker',
                    html: iconHtml,
                    iconSize: [24, 24],
                    iconAnchor: [12, 12]
                });
                
                const marker = L.marker([node.position.latitude, node.position.longitude], { icon })
                    .bindPopup(() => {
                        try {
                            // Prevent popup during zoom animations
                            if (this.isZooming || !this.map || !this.map._loaded) {
                                return '';
                            }
                            return this.createNodePopup(node);
                        } catch (error) {
                            console.error('Error creating popup:', error);
                            return '';
                        }
                    })
                    .addTo(this.nodeLayer);
                
                // Store marker reference
                node.marker = marker;
                
                // No overlap detection needed - built-in spiderfying handles it
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
                        ${info.last_seen_hours_ago !== null ? `<p><strong>Last packet:</strong> ${this.getTimeAgoText(info.last_seen_hours_ago)}</p>` : ''}
                        ${position.latitude ? `<p><strong>Position:</strong> ${position.latitude.toFixed(6)}, ${position.longitude.toFixed(6)}</p>` : ''}
                        ${position.position_age_hours_ago != null ? `<p><strong>Last position:</strong> ${this.getTimeAgoText(position.position_age_hours_ago)}</p>` : (position.latitude ? '<p><strong>Position age:</strong> Unknown</p>' : '')}
                        ${position.altitude ? `<p><strong>Altitude:</strong> ${position.altitude}m</p>` : ''}
                        ${position.ground_speed_ms !== undefined && position.ground_speed_ms !== null && position.ground_speed_ms > 0 ? `<p><strong>Ground Speed:</strong> ${position.ground_speed_ms.toFixed(1)} m/s (${(position.ground_speed_ms * 3.6).toFixed(1)} km/h)</p>` : ''}
                        ${position.heading !== null && position.heading !== undefined && position.ground_speed_ms !== undefined && position.ground_speed_ms !== null && position.ground_speed_ms > 0 ? `<p><strong>Heading:</strong> ${position.heading.toFixed(1)}° (${this.getCompassDirection(position.heading)})</p>` : ''}
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

            if (typeof hoursAgo !== 'number' || Number.isNaN(hoursAgo) || !Number.isFinite(hoursAgo)) {
                return 'Never seen';
            }

            if (hoursAgo < 0) {
                hoursAgo = 0;
            }
            
            if (hoursAgo < 1) {
                const minutes = Math.round(hoursAgo * 60);
                if (minutes < 1) {
                    return 'Less than 1 minute ago';
                } else if (minutes === 1) {
                    return '1 minute ago';
                } else {
                    return `${minutes} minutes ago`;
                }
            } else if (hoursAgo < 24) {
                let wholeHours = Math.floor(hoursAgo);
                let remainingMinutes = Math.round((hoursAgo - wholeHours) * 60);

                if (remainingMinutes === 60) {
                    wholeHours += 1;
                    remainingMinutes = 0;
                }

                if (wholeHours >= 24) {
                    return '1 day ago';
                }
                
                if (remainingMinutes === 0) {
                    return `${wholeHours} hour${wholeHours === 1 ? '' : 's'} ago`;
                } else {
                    return `${wholeHours} hour${wholeHours === 1 ? '' : 's'} ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'} ago`;
                }
            } else {
                let days = Math.floor(hoursAgo / 24);
                let remainingHours = Math.round((hoursAgo % 24));

                if (remainingHours === 24) {
                    days += 1;
                    remainingHours = 0;
                }
                
                if (remainingHours === 0) {
                    return `${days} day${days === 1 ? '' : 's'} ago`;
                } else {
                    return `${days} day${days === 1 ? '' : 's'} ${remainingHours} hour${remainingHours === 1 ? '' : 's'} ago`;
                }
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
        },
        
        // Placeholder for future event-driven animations
        animateNodeEvent(nodeId, eventType, data) {
            // Future: blinking markers, communication lines, etc.
            console.log(`Event animation placeholder: ${eventType} for node ${nodeId}`);
        },

        // Placeholder for event animation system
        initializeEventAnimations() {
            // Future: socket.io integration, event listeners
            console.log('Event animations placeholder - to be implemented');
        }
    };
}
