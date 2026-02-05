document.getElementById("loginBtn").onclick = () => {
  var username = document.getElementById('username').value;
  if (!username || username.length > 12) {
    console.log('try another username please :)');
  } else {
    window.location.href = `https://scheduler-backend-9b2i.onrender.com/auth/google?username=${encodeURIComponent(username)}`;
  }
};