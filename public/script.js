const socket = io();
let token = localStorage.getItem("token");

async function register(){
await fetch("/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:username.value,password:password.value})});
alert("Registriert!");
}

async function login(){
const res=await fetch("/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:username.value,password:password.value})});
const data=await res.json();
localStorage.setItem("token",data.token);
window.location="dashboard.html";
}

function logout(){localStorage.removeItem("token");window.location="index.html";}

async function addItem(){
await fetch("/inventory",{method:"POST",headers:{"Content-Type":"application/json","Authorization":token},body:JSON.stringify({name:name.value,quantity:quantity.value})});
load();
}

async function deleteItem(id){
await fetch("/inventory/"+id,{method:"DELETE",headers:{"Authorization":token}});
load();
}

async function load(){
const res=await fetch("/inventory",{headers:{"Authorization":token}});
const items=await res.json();
const tbody=document.getElementById("tableBody");
tbody.innerHTML="";
items.forEach(i=>{
const row=document.createElement("tr");
row.innerHTML=`<td>${i.id}</td><td>${i.name}</td><td>${i.quantity}</td><td><button onclick="deleteItem(${i.id})">❌</button></td>`;
tbody.appendChild(row);
});
updateChart(items);
}

let chart;
function updateChart(items){
const ctx=document.getElementById("chart").getContext("2d");
if(chart) chart.destroy();
chart=new Chart(ctx,{
type:"bar",
data:{labels:items.map(i=>i.name),datasets:[{label:"Bestand",data:items.map(i=>i.quantity)}]}
});
}

socket.on("update",()=>load());
if(window.location.pathname.includes("dashboard")) load();
