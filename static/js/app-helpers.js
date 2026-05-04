// Pure utility functions shared across all app modules.
// Global-scope so mixin methods can call them without `this`.

function sanitizeHtml(str) {
  if (str === null || str === undefined) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function getStatusClass(status) {
  switch (status) {
    case "currently_active":
      return "currently-active";
    case "recently_active":
      return "recently-active";
    case "inactive":
    default:
      return "inactive";
  }
}

function getStatusLabel(status) {
  switch (status) {
    case "currently_active":
      return "Currently Active";
    case "recently_active":
      return "Recently Active";
    case "inactive":
    default:
      return "Inactive";
  }
}

function getTimeAgoText(hoursAgo) {
  if (hoursAgo === null || hoursAgo === undefined) {
    return "Never seen";
  }

  if (
    typeof hoursAgo !== "number" ||
    Number.isNaN(hoursAgo) ||
    !Number.isFinite(hoursAgo)
  ) {
    return "Never seen";
  }

  if (hoursAgo < 0) {
    hoursAgo = 0;
  }

  if (hoursAgo < 1) {
    const minutes = Math.round(hoursAgo * 60);
    if (minutes < 1) {
      return "Less than 1 minute ago";
    } else if (minutes === 1) {
      return "1 minute ago";
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
      return "1 day ago";
    }

    if (remainingMinutes === 0) {
      return `${wholeHours} hour${wholeHours === 1 ? "" : "s"} ago`;
    } else {
      return `${wholeHours} hour${wholeHours === 1 ? "" : "s"} ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"} ago`;
    }
  } else {
    let days = Math.floor(hoursAgo / 24);
    let remainingHours = Math.round(hoursAgo % 24);

    if (remainingHours === 24) {
      days += 1;
      remainingHours = 0;
    }

    if (remainingHours === 0) {
      return `${days} day${days === 1 ? "" : "s"} ago`;
    } else {
      return `${days} day${days === 1 ? "" : "s"} ${remainingHours} hour${remainingHours === 1 ? "" : "s"} ago`;
    }
  }
}

// Convert degrees to compass direction
function getCompassDirection(degrees) {
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const index = Math.round(degrees / 45) % 8;
  return directions[index];
}

// Role-based MDI icon mapping
function getIconForRole(role) {
  const roleIcons = {
    CLIENT: "mdi-radio-tower",
    CLIENT_MUTE: "mdi-volume-mute",
    CLIENT_BASE: "mdi-home",
    ROUTER: "mdi-hub-outline",
    ROUTER_LATE: "mdi-hubspot",
    REPEATER: "mdi-repeat",
    SENSOR: "mdi-thermometer",
    TRACKER: "mdi-crosshairs-gps",
    TAK: "mdi-radar",
    TAK_TRACKER: "mdi-radar",
  };
  return roleIcons[role] || "mdi-help-circle";
}

function getGroundSpeedKmph(position) {
  if (!position) return null;
  return position.ground_speed_kmph !== undefined && position.ground_speed_kmph !== null
    ? position.ground_speed_kmph
    : null;
}
