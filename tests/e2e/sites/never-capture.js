// The show toggle turns the password into a plain text field (it was a password in this document,
// so it stays a secret), and a script writes a hidden value the user never types.
const password = document.getElementById("password");
document.getElementById("show-password").addEventListener("click", () => {
  password.type = password.type === "password" ? "text" : "password";
});
document.getElementById("session").value = "hidden-7Qx9-session";
