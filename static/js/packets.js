// ===== CONFIGURATION & CONSTANTS =====
const CONFIG = {
    SOCKET_NAMESPACE: window.APP_CONFIG?.SOCKET_NAMESPACE || '/packets',
    PORT_COLORS: {
        'NODEINFO_APP': 'port-nodeinfo',
        'TRACEROUTE_APP': 'port-traceroute', 
        'TEXT_MESSAGE_APP': 'port-textmsg',
        'POSITION_APP': 'port-position',
        'ROUTING_APP': 'port-routing',
        'TELEMETRY_APP': 'port-telemetry'
    },
    TABLE_FIELDS: [
        {label: 'Received', value: 'received', colClass: 'col-received received-col'},
        {label: 'Message ID', value: 'id_', colClass: 'col-id other-col'},
        {label: 'From', value: 'fromDisplay', colClass: 'col-from other-col'},
        {label: 'To', value: 'toDisplay', colClass: 'col-to other-col'},
        {label: 'Channel', value: 'channel_name', colClass: 'col-channel other-col'},
        {label: 'Port', value: 'portnum', colClass: 'col-port other-col'},
        {label: 'Relay (Received Via)', value: 'relay_node', colClass: 'col-relay other-col'},
        {label: 'MQTT Uplink', value: 'uplinkDisplay', colClass: 'col-uplink other-col'},
        {label: 'Next Hop', value: 'next_hop', colClass: 'col-next other-col'}
    ]
};

// ===== DOM ELEMENT REFERENCES =====
const DOM = {
    logDiv: document.getElementById('log'),
    collapseAllBtn: document.getElementById('collapse-all'),
    clearAllBtn: document.getElementById('clear-all'),
    showDuplicatesCheckbox: document.getElementById('show-duplicates')
};

// ===== SOCKET.IO CLIENT =====
const socket = io(CONFIG.SOCKET_NAMESPACE);

// ===== UTILITY FUNCTIONS =====
const Utils = {
    /**
     * Safely parse JSON string
     * @param {string} rawData - JSON string to parse
     * @returns {object|null} Parsed object or null if invalid
     */
    safeParse(rawData) {
        if (typeof rawData !== 'string') return rawData;
        try {
            return JSON.parse(rawData);
        } catch (e) {
            console.warn('Invalid JSON received:', rawData?.substring(0, 100));
            return null;
        }
    },

    /**
     * Escape HTML to prevent XSS
     * @param {string} text - Text to escape
     * @returns {string} Escaped HTML
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    /**
     * Format Unix timestamp or datetime string to readable string
     * @param {number|string} timeValue - Unix timestamp or datetime string
     * @returns {string} Formatted date/time
     */
    formatTimestamp(timeValue) {
        if (!timeValue || timeValue === null || timeValue === undefined) return 'N/A';
        try {
            let date;
            if (typeof timeValue === 'number') {
                // Unix timestamp (seconds)
                date = new Date(timeValue * 1000);
            } else if (typeof timeValue === 'string') {
                // ISO datetime string
                date = new Date(timeValue);
            } else {
                return 'Invalid';
            }
            return date.toLocaleString();
        } catch (e) {
            return 'Invalid';
        }
    },

    /**
     * Convert number to hexadecimal string
     * @param {number} n - Number to convert
     * @param {number} digits - Number of digits to pad
     * @returns {string} Hexadecimal string
     */
    toHex(n, digits = 8) {
        const num = +n;
        if (!num) return '0'.repeat(digits);
        return (BigInt(num)).toString(16).padStart(digits, '0');
    },

    /**
     * Get display name from node object
     * @param {object} nodeObj - Node object with name properties
     * @returns {string} Display name or undefined
     */
    getNodeDisplayName(nodeObj) {
        return nodeObj?.name || nodeObj?.short_name || nodeObj?.long_name;
    },

    /**
     * Format node ID as hexadecimal
     * @param {number} nodeNum - Node number
     * @returns {string} Formatted node ID
     */
    formatHexNodeId(nodeNum) {
        return nodeNum !== undefined ? '!' + this.toHex(nodeNum) : 'N/A';
    },

    /**
     * Format destination node ID with broadcast handling
     * @param {number} nodeNum - Node number
     * @returns {string} Formatted destination ID
     */
    formatToNodeId(nodeNum) {
        if (nodeNum === undefined) return 'N/A';
        return nodeNum === 4294967295 ? 'BROADCAST' : '!' + this.toHex(nodeNum);
    },

    /**
     * Combine node ID with display name
     * @param {string} idText - Node ID text
     * @param {string} nameText - Node name text
     * @returns {string} Combined display text
     */
    formatNodeWithName(idText, nameText) {
        return nameText ? `${idText} (${nameText})` : idText;
    }
};

// ===== DATA PROCESSING =====
const DataProcessor = {
    /**
     * Process raw line data into formatted display values
     * @param {object} lineData - Raw packet data
     * @returns {object} Processed data with display values
     */
    processLineData(lineData) {
        const id_ = lineData.id_ !== undefined ? String(lineData.id_) : 'N/A';
        const fromId = Utils.formatHexNodeId(lineData.from_);
        const toId = Utils.formatToNodeId(lineData.to);
        const uplinkId = lineData.uplink || 'N/A';

        const fromDisplay = Utils.formatNodeWithName(fromId, Utils.getNodeDisplayName(lineData.from_node));
        const toDisplay = toId === 'BROADCAST' ? 'BROADCAST' : Utils.formatNodeWithName(toId, Utils.getNodeDisplayName(lineData.to_node));
        const uplinkDisplay = Utils.formatNodeWithName(uplinkId, Utils.getNodeDisplayName(lineData.uplink_node));

        const channel_name = lineData.channel_name || 'N/A';
        const portnum = lineData.decoded?.portnum || 'N/A';
        const relay_node = lineData.relay_node !== null ? Utils.toHex(lineData.relay_node, 2) : 'N/A';
        const next_hop = lineData.next_hop !== null ? Utils.toHex(lineData.next_hop, 2) : 'N/A';
        const received = Utils.formatTimestamp(lineData.created_at);

        return {
            ...lineData,
            id_,
            fromDisplay,
            toDisplay,
            uplinkDisplay,
            channel_name,
            portnum,
            relay_node,
            next_hop,
            received
        };
    }
};

// ===== DOM RENDERING =====
const Renderer = {
    /**
     * Create a compact log line element
     * @param {object} lineData - Processed packet data
     * @returns {HTMLElement} Log line element
     */
    renderCompact(lineData) {
        const processedData = DataProcessor.processLineData(lineData);
        
        const logLine = this.createLogLineContainer(processedData);
        const compactRow = this.createCompactRow(processedData);
        
        logLine.appendChild(compactRow);
        this.attachEventListeners(logLine);
        
        return logLine;
    },

    /**
     * Create the main log line container
     * @param {object} processedData - Processed packet data
     * @returns {HTMLElement} Log line container
     */
    createLogLineContainer(processedData) {
        const logLine = document.createElement('div');
        logLine.className = 'log-line';
        logLine.dataset.rawData = JSON.stringify(processedData);
        logLine.dataset.isExpanded = 'false';
        return logLine;
    },

    /**
     * Create the compact row with table
     * @param {object} processedData - Processed packet data
     * @returns {HTMLElement} Compact row element
     */
    createCompactRow(processedData) {
        const compactRow = document.createElement('div');
        compactRow.className = 'compact-row';
        
        // Mobile summary
        const mobileSummary = `Port: ${processedData.portnum} | ${processedData.fromDisplay} → ${processedData.toDisplay}`;
        compactRow.dataset.summary = mobileSummary;

        const table = this.createTable(processedData);
        compactRow.appendChild(table);
        
        this.addIndicators(compactRow, processedData);
        
        return compactRow;
    },

    /**
     * Create the data table
     * @param {object} processedData - Processed packet data
     * @returns {HTMLElement} Table element
     */
    createTable(processedData) {
        const table = document.createElement('table');
        const portColorClass = CONFIG.PORT_COLORS[processedData.portnum];
        if (portColorClass) {
            table.classList.add(portColorClass);
        }

        const row = table.insertRow();
        
        CONFIG.TABLE_FIELDS.forEach(field => {
            const cell = row.insertCell();
            cell.className = field.colClass;
            cell.innerHTML = `
                <div class="compact-label">${Utils.escapeHtml(field.label)}</div>
                <div class="compact-value">${Utils.escapeHtml(processedData[field.value] || 'N/A')}</div>
            `;
        });

        return table;
    },

    /**
     * Add expand and duplicate indicators
     * @param {HTMLElement} compactRow - Row element
     * @param {object} processedData - Processed packet data
     */
    addIndicators(compactRow, processedData) {
        // Expand indicator
        const indicator = document.createElement('div');
        indicator.className = 'expand-indicator';
        indicator.textContent = '▼';
        compactRow.appendChild(indicator);
        
        // Duplicate indicator
        if (processedData.is_duplicate === true) {
            const duplicateIndicator = document.createElement('div');
            duplicateIndicator.className = 'duplicate-indicator';
            duplicateIndicator.textContent = '🔄';
            duplicateIndicator.title = 'This packet is a duplicate';
            compactRow.appendChild(duplicateIndicator);
        }
    },

    /**
     * Attach click event listener
     * @param {HTMLElement} logLine - Log line element
     */
    attachEventListeners(logLine) {
        logLine.addEventListener('click', (e) => {
            if (e.target.closest('.expand-indicator')) return;
            UIController.toggleExpand(logLine);
        });
    }
};

// ===== UI CONTROLLER =====
const UIController = {
    /**
     * Toggle expansion of a log line
     * @param {HTMLElement} logLine - Log line element
     */
    toggleExpand(logLine) {
        const isExpanded = logLine.dataset.isExpanded === 'true';
        
        if (isExpanded) {
            this.collapseLine(logLine);
        } else {
            this.expandLine(logLine);
        }
    },

    /**
     * Expand a log line to show JSON
     * @param {HTMLElement} logLine - Log line element
     */
    expandLine(logLine) {
        const rawData = JSON.parse(logLine.dataset.rawData);
        const jsonDiv = document.createElement('div');
        jsonDiv.className = 'full-json';
        jsonDiv.textContent = JSON.stringify(rawData, null, 2);
        logLine.appendChild(jsonDiv);
        logLine.classList.add('expanded');
        logLine.dataset.isExpanded = 'true';
    },

    /**
     * Collapse a log line to hide JSON
     * @param {HTMLElement} logLine - Log line element
     */
    collapseLine(logLine) {
        const jsonBlock = logLine.querySelector('.full-json');
        if (jsonBlock) jsonBlock.remove();
        logLine.classList.remove('expanded');
        logLine.dataset.isExpanded = 'false';
    },

    /**
     * Collapse all expanded log lines
     */
    collapseAll() {
        const expandedLines = DOM.logDiv.querySelectorAll('.log-line.expanded');
        expandedLines.forEach(logLine => this.collapseLine(logLine));
    },

    /**
     * Clear all log lines
     */
    clearAll() {
        DOM.logDiv.innerHTML = '';
    },

    /**
     * Filter existing packets based on duplicate setting
     */
    filterExistingPackets() {
        const showDuplicates = DOM.showDuplicatesCheckbox.checked;
        const allLogLines = DOM.logDiv.querySelectorAll('.log-line');
        
        allLogLines.forEach((logLine) => {
            const rawData = JSON.parse(logLine.dataset.rawData);
            const isDuplicate = rawData.is_duplicate === true;
            
            logLine.style.display = showDuplicates || !isDuplicate ? 'block' : 'none';
        });
    },

    /**
     * Add a new log line to the display
     * @param {object} rawData - Raw packet data
     */
    addLogLine(rawData) {
        let lineData = Utils.safeParse(rawData);
        if (!lineData) return;
        
        const logLine = Renderer.renderCompact(lineData);
        DOM.logDiv.appendChild(logLine);
        DOM.logDiv.scrollTop = DOM.logDiv.scrollHeight;
        
        // Apply current filter to the new packet
        this.filterExistingPackets();
    }
};

// ===== EVENT LISTENERS =====
function initializeEventListeners() {
    DOM.collapseAllBtn.addEventListener('click', UIController.collapseAll);
    DOM.clearAllBtn.addEventListener('click', UIController.clearAll);
    DOM.showDuplicatesCheckbox.addEventListener('change', UIController.filterExistingPackets);
}

// ===== SOCKET.IO EVENT HANDLERS =====
function initializeSocketHandlers() {
    socket.on('connect', () => {
        console.log('Connected to socket');
    });
    
    socket.on('disconnect', () => {
        console.log('Disconnected from socket');
    });
    
    socket.on('packets', data => {
        UIController.addLogLine(data);
    });
}

// ===== INITIALIZATION =====
function initializeApp() {
    initializeEventListeners();
    initializeSocketHandlers();
}

// Start the application when DOM is ready
document.addEventListener('DOMContentLoaded', initializeApp);
