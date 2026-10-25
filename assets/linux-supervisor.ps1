param([switch]$CompileOnly, [string]$AssemblyPath = (Join-Path $PSScriptRoot 'linux-supervisor.dll'))
$ErrorActionPreference = 'Stop'
# A private, single-invocation subreaper. Cancellation never signals a bare PID.
# Descendants orphaned by killing their parent are adopted here, including setsid children.
if ($CompileOnly) {
Add-Type -OutputAssembly $AssemblyPath -TypeDefinition @'
using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class LinuxJob {
 [DllImport("libc", SetLastError=true)] static extern int prctl(int option, ulong value, ulong a, ulong b, ulong c);
 [DllImport("libc", SetLastError=true)] static extern long syscall(long number, long a, long b, long c, long d);
 [DllImport("libc")] static extern int close(int fd);
 [DllImport("libc")] static extern int waitpid(int pid, out int status, int options);
 static volatile bool cancel;
 static string nonce;
 static readonly object gate = new object();
 static void Emit(string s) { lock(gate) Console.WriteLine(s); }
 static int Parent(int pid) {
  var s=File.ReadAllText("/proc/"+pid+"/stat");
  var parts=s.Substring(s.LastIndexOf(')')+2).Split(' ');
  return int.Parse(parts[1]);
 }
 static List<int> Children() {
  var result=new List<int>(); int self=Environment.ProcessId;
  foreach(var path in Directory.EnumerateDirectories("/proc")) {
   int pid; if(!int.TryParse(Path.GetFileName(path),out pid)) continue;
   try { if(Parent(pid)==self) result.Add(pid); } catch(FileNotFoundException) {} catch(DirectoryNotFoundException) {}
  }
  return result;
 }
 static void KillOwned(int pid) {
  // Linux syscall numbers are identical on x64 and arm64 for pidfd operations.
  int fd=(int)syscall(434,pid,0,0,0);
  if(fd<0) { if(Marshal.GetLastWin32Error()==3) return; throw new Exception("pidfd_open failed"); }
  try {
   // Opening the fd can race exit/reuse. Recheck ancestry AFTER the fd binds identity.
   // If the PID has since been reused, the fd still cannot signal the new process.
   if(Parent(pid)!=Environment.ProcessId) throw new Exception("Ownership changed");
   if(syscall(424,fd,9,0,0)<0 && Marshal.GetLastWin32Error()!=3) throw new Exception("pidfd signal failed");
  } catch(FileNotFoundException) {} catch(DirectoryNotFoundException) {} finally { close(fd); }
 }
 static Thread Drain(Stream input,string stream) {
  var t=new Thread(()=>{ try { var b=new byte[4096];int n;while((n=input.Read(b,0,b.Length))>0) Emit("{\"event\":\"chunk\",\"nonce\":\""+nonce+"\",\"stream\":\""+stream+"\",\"data\":\""+Convert.ToBase64String(b,0,n)+"\"}"); } catch { Emit("{\"event\":\"unknown\",\"nonce\":\""+nonce+"\"}"); } });
  t.IsBackground=true;t.Start();return t;
 }
 public static void Run(string program,string[] args,string cwd,string input,string token) {
  nonce=token;Process root=null;
  try {
   if(prctl(36,1,0,0,0)!=0) throw new Exception("Subreaper unavailable");
   var info=new ProcessStartInfo(program) { UseShellExecute=false,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true };
   if(!string.IsNullOrEmpty(cwd)) info.WorkingDirectory=cwd;
   foreach(var arg in args) info.ArgumentList.Add(arg);
   root=Process.Start(info);
   Emit("{\"event\":\"started\",\"nonce\":\""+nonce+"\"}");
   var stdout=Drain(root.StandardOutput.BaseStream,"stdout");var stderr=Drain(root.StandardError.BaseStream,"stderr");
   var writer=new Thread(()=>{try { var b=Convert.FromBase64String(input??"");root.StandardInput.BaseStream.Write(b,0,b.Length);root.StandardInput.Close(); }catch{} });writer.IsBackground=true;writer.Start();
   var reader=new Thread(()=>{var s=Console.ReadLine();cancel=s==null||s=="cancel "+nonce;});reader.IsBackground=true;reader.Start();
   bool cancelled=false;var deadline=DateTime.MaxValue;
   while(true) {
    if(cancel&&!cancelled) {cancelled=true;deadline=DateTime.UtcNow.AddSeconds(4);}
    bool exited=root.HasExited;
    var children=Children();
    foreach(var pid in children) {
     if(cancelled) KillOwned(pid);
     if(pid!=root.Id) {int status;waitpid(pid,out status,1);}
    }
    // All descendants are either below a live root or have been adopted by us.
    // Empty direct-child set after root exit therefore proves the entire tree exited.
    if(exited&&Children().Count==0) break;
    if(cancelled&&DateTime.UtcNow>deadline) throw new Exception("Termination unconfirmed");
    Thread.Sleep(10);
   }
   if(!stdout.Join(500)||!stderr.Join(500)) throw new Exception("Drain unconfirmed");
   Emit("{\"event\":\"finished\",\"nonce\":\""+nonce+"\",\"active\":0,\"exitCode\":"+root.ExitCode+",\"cancelled\":"+(cancelled?"true":"false")+"}");
  } catch { Emit("{\"event\":\"unknown\",\"nonce\":\""+nonce+"\"}"); }
 }
}
'@
exit
}
# Compile once at build time: starting Roslyn for every invocation made even a
# trivial native command exceed the lifecycle polling bound on Linux CI.
Add-Type -Path $AssemblyPath
$request = [Console]::ReadLine() | ConvertFrom-Json
if ([string]$request.nonce -cnotmatch '^[a-f0-9]{48}$') { throw 'Invalid request' }
[LinuxJob]::Run([string]$request.program, [string[]]@($request.args), [string]$request.cwd, [string]$request.input, [string]$request.nonce)
