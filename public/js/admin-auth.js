async function requireAdminPage() {
  try {
    const res = await fetch("/api/admin/me", {
      method: "GET",
      credentials: "same-origin"
    });

    if (!res.ok) {
      redirectToAdminLogin();
      return null;
    }

    const data = await res.json();

    if (!data.success || !data.loggedIn) {
      redirectToAdminLogin();
      return null;
    }

    window.currentAdmin = data.admin;
    return data.admin;
  } catch (err) {
    console.error("Admin auth check failed:", err);
    redirectToAdminLogin();
    return null;
  }
}

function redirectToAdminLogin() {
  const currentUrl = window.location.pathname + window.location.search;
  window.location.href = "/admin_login.html?next=" + encodeURIComponent(currentUrl);
}

async function adminLogout() {
  try {
    await fetch("/api/admin/logout", {
      method: "POST",
      credentials: "same-origin"
    });
  } catch (err) {
    console.error("Logout failed:", err);
  }

  window.location.href = "/admin_login.html";
}

function addAdminLogoutButton() {
  if (document.getElementById("adminLogoutBtn")) return;

  const btn = document.createElement("button");
  btn.id = "adminLogoutBtn";
  btn.textContent = "Logout";
  btn.onclick = adminLogout;

  btn.style.position = "fixed";
  btn.style.top = "12px";
  btn.style.right = "12px";
  btn.style.zIndex = "9999";
  btn.style.padding = "8px 14px";
  btn.style.border = "none";
  btn.style.borderRadius = "6px";
  btn.style.background = "#333";
  btn.style.color = "#fff";
  btn.style.cursor = "pointer";

  document.body.appendChild(btn);
}
