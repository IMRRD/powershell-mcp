$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
$source = @'
using System;
using System.Text;
using System.IO;
using System.Threading;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
public static class NativeJob {
 public static volatile bool CancelRequested;
 public static string Nonce;
 static readonly object OutputLock = new object();
 public static void Emit(string message) { lock(OutputLock) Console.Out.WriteLine(message); }
 public static void ReadCancel() { var line = Console.ReadLine(); CancelRequested = line == null || line == "cancel " + Nonce; }
 public static void Input(IntPtr handle, byte[] bytes) {
  var thread = new Thread(() => { try { using(var stream = new FileStream(new SafeFileHandle(handle, true), FileAccess.Write, 4096, false)) { stream.Write(bytes,0,bytes.Length); } } catch {} });
  thread.IsBackground=true; thread.Start();
 }
 public static void StartRead() { var thread = new Thread(new ThreadStart(ReadCancel)); thread.IsBackground = true; thread.Start(); }
 public static Thread Drain(IntPtr handle, string stream) {
  var thread = new Thread(() => {
   try {
    using (var input = new FileStream(new SafeFileHandle(handle, false), FileAccess.Read, 4096, false)) {
     var bytes = new byte[4096]; int count;
     while ((count = input.Read(bytes, 0, bytes.Length)) != 0)
      Emit("{\"event\":\"chunk\",\"nonce\":\"" + Nonce + "\",\"stream\":\"" + stream + "\",\"data\":\"" + Convert.ToBase64String(bytes, 0, count) + "\"}");
    }
   } catch { Emit("{\"event\":\"unknown\",\"nonce\":\"" + Nonce + "\"}"); }
  });
  thread.IsBackground = true; thread.Start(); return thread;
 }
 [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFO { public uint cb; public string lpReserved; public string lpDesktop; public string lpTitle; public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize; public uint dwXCountChars; public uint dwYCountChars; public uint dwFillAttribute; public uint dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
 [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }
 [StructLayout(LayoutKind.Sequential)] public struct BASIC_ACCOUNTING { public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime; public long ThisPeriodTotalKernelTime; public uint TotalPageFaultCount; public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses; }
 [StructLayout(LayoutKind.Sequential)] public struct LIMITS { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
 [StructLayout(LayoutKind.Sequential)] public struct EXTENDED { public LIMITS BasicLimitInformation; public long A; public long B; public long C; public long D; public long E; public long F; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr security,string name);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job,int kind,ref EXTENDED info,int size);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr job,int kind,out BASIC_ACCOUNTING info,int size,out int returned);
 [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFOEX { public STARTUPINFO startup; public IntPtr attributes; }
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode,EntryPoint="CreateProcessW")] static extern bool CreateProcessLimited(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFOEX si,out PROCESS_INFORMATION pi);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 public static bool Launch(string app,StringBuilder cmd,string cwd,IntPtr stdin,IntPtr stdout,IntPtr stderr,out PROCESS_INFORMATION pi) {
  var size = IntPtr.Zero;
  InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
  var attributes = Marshal.AllocHGlobal(size);
  var handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
  var policy = Marshal.AllocHGlobal(4);
  pi = new PROCESS_INFORMATION();
  bool initialized = false;
  try {
   if (!InitializeProcThreadAttributeList(attributes,2,0,ref size)) return false;
   initialized = true;
   Marshal.WriteIntPtr(handles,0,stdout); Marshal.WriteIntPtr(handles,IntPtr.Size,stderr); Marshal.WriteIntPtr(handles,IntPtr.Size * 2,stdin);
   if (!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size * 3),IntPtr.Zero,IntPtr.Zero)) return false;
   // Desktop Bridge (Store-installed pwsh) otherwise brokers native children out
   // of the job. Keep its process tree in the same desktop runtime environment.
   Marshal.WriteInt32(policy,2);
   if (!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20012),policy,new IntPtr(4),IntPtr.Zero,IntPtr.Zero)) return false;
   var info = new STARTUPINFOEX(); info.startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX)); info.attributes = attributes;
   info.startup.dwFlags = 0x100; info.startup.hStdInput = stdin; info.startup.hStdOutput = stdout; info.startup.hStdError = stderr;
   // CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED.
   return CreateProcessLimited(app,cmd,IntPtr.Zero,IntPtr.Zero,true,0x08080004,IntPtr.Zero,cwd,ref info,out pi);
  } finally {
   if (initialized) DeleteProcThreadAttributeList(attributes);
   Marshal.FreeHGlobal(policy); Marshal.FreeHGlobal(handles); Marshal.FreeHGlobal(attributes);
  }
 }
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [StructLayout(LayoutKind.Sequential)] public struct SECURITY_ATTRIBUTES { public uint length; public IntPtr descriptor; public bool inherit; }
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SECURITY_ATTRIBUTES sa,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
}
'@
Add-Type -TypeDefinition $source
function Quote-Arg([string]$s) {
 if ($s.Length -gt 0 -and $s -notmatch '[\s"]') { return $s }
 $result='"'; $slashes=0
 foreach ($c in $s.ToCharArray()) {
  if ($c -eq '\') { $slashes++; continue }
  if ($c -eq '"') { $result += ('\' * ($slashes * 2 + 1)) + '"'; $slashes=0; continue }
  $result += ('\' * $slashes) + $c; $slashes=0
 }
 return $result + ('\' * ($slashes * 2)) + '"'
}
function Active([IntPtr]$job) {
 $a=New-Object NativeJob+BASIC_ACCOUNTING; $n=0
 if (-not [NativeJob]::QueryInformationJobObject($job,1,[ref]$a,[Runtime.InteropServices.Marshal]::SizeOf([type][NativeJob+BASIC_ACCOUNTING]),[ref]$n)) { throw 'Job accounting failed' }
 return $a.ActiveProcesses
}
$job=[IntPtr]::Zero; $pi=New-Object NativeJob+PROCESS_INFORMATION; $out=[IntPtr]::Zero; $err=[IntPtr]::Zero; $readOut=[IntPtr]::Zero; $readErr=[IntPtr]::Zero; $inputRead=[IntPtr]::Zero; $inputWrite=[IntPtr]::Zero; $launched=$false
try {
 $request=[Console]::In.ReadLine() | ConvertFrom-Json
 if (-not $request -or -not $request.program -or [string]$request.nonce -cnotmatch '^[a-f0-9]{48}$' -or $request.args.Count -gt 256) { throw 'Invalid request' }
 [NativeJob]::Nonce=[string]$request.nonce
 $job=[NativeJob]::CreateJobObject([IntPtr]::Zero,$null); if ($job -eq [IntPtr]::Zero) { throw 'Job creation failed' }
 $limit=New-Object NativeJob+EXTENDED; $limit.BasicLimitInformation.LimitFlags=0x2000
 if (-not [NativeJob]::SetInformationJobObject($job,9,[ref]$limit,[Runtime.InteropServices.Marshal]::SizeOf([type][NativeJob+EXTENDED]))) { throw 'Job limits failed' }
 $sa=New-Object NativeJob+SECURITY_ATTRIBUTES; $sa.length=[Runtime.InteropServices.Marshal]::SizeOf([type][NativeJob+SECURITY_ATTRIBUTES]); $sa.inherit=$true
 if (-not [NativeJob]::CreatePipe([ref]$readOut,[ref]$out,[ref]$sa,0) -or -not [NativeJob]::CreatePipe([ref]$readErr,[ref]$err,[ref]$sa,0)) { throw 'Output pipe failed' }
 if (-not [NativeJob]::SetHandleInformation($readOut,1,0) -or -not [NativeJob]::SetHandleInformation($readErr,1,0)) { throw 'Output pipe inheritance failed' }
 if (-not [NativeJob]::CreatePipe([ref]$inputRead,[ref]$inputWrite,[ref]$sa,0) -or -not [NativeJob]::SetHandleInformation($inputWrite,1,0)) { throw 'Input pipe failed' }
 $parts=@($request.program) + @($request.args); $command=New-Object Text.StringBuilder (($parts | ForEach-Object { Quote-Arg ([string]$_) }) -join ' ')
 $cwd=if ($request.cwd) { [string]$request.cwd } else { [Environment]::CurrentDirectory }
 if (-not [NativeJob]::Launch($request.program,$command,$cwd,$inputRead,$out,$err,[ref]$pi)) { throw "CreateProcess failed Win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
 if (-not [NativeJob]::AssignProcessToJobObject($job,$pi.hProcess)) { throw 'AssignProcessToJobObject failed' }
 if ([NativeJob]::ResumeThread($pi.hThread) -eq [uint32]::MaxValue) { throw 'ResumeThread failed' }
 $launched=$true
 [void][NativeJob]::CloseHandle($inputRead); $inputRead=[IntPtr]::Zero
 $inputBytes=if ($request.input) { [Convert]::FromBase64String([string]$request.input) } else { New-Object byte[] 0 }
 [NativeJob]::Input($inputWrite,$inputBytes); $inputWrite=[IntPtr]::Zero
 [void][NativeJob]::CloseHandle($out); $out=[IntPtr]::Zero
 [void][NativeJob]::CloseHandle($err); $err=[IntPtr]::Zero
 [NativeJob]::Emit('{"event":"started","nonce":"' + [NativeJob]::Nonce + '"}')
 $stdoutThread=[NativeJob]::Drain($readOut,'stdout'); $stderrThread=[NativeJob]::Drain($readErr,'stderr')
 [NativeJob]::StartRead()
 $cancelled=$false; $deadline=[DateTime]::UtcNow.AddSeconds(15)
 while ($true) {
  if ([NativeJob]::CancelRequested -and -not $cancelled) { $cancelled=$true; if (-not [NativeJob]::TerminateJobObject($job,82)) { throw 'TerminateJobObject failed' }; $deadline=[DateTime]::UtcNow.AddSeconds(4) }
  $active=Active $job
  if ($active -eq 0) { break }
  if ($cancelled -and [DateTime]::UtcNow -gt $deadline) { throw 'Termination not confirmed' }
  [void][NativeJob]::WaitForSingleObject($pi.hProcess,100)
 }
 if (-not $stdoutThread.Join(500) -or -not $stderrThread.Join(500)) { throw 'Output drain not confirmed' }
 $code=[uint32]0; if (-not [NativeJob]::GetExitCodeProcess($pi.hProcess,[ref]$code)) { throw 'Exit code unavailable' }
 [NativeJob]::Emit((@{event='finished';nonce=[NativeJob]::Nonce;cancelled=$cancelled;exitCode=[int64]$code;active=0} | ConvertTo-Json -Compress))
} catch {
 [Console]::Error.WriteLine($_.Exception.ToString())
 if ($pi.hProcess -ne [IntPtr]::Zero -and -not $launched) { [void][NativeJob]::TerminateProcess($pi.hProcess,81) }
 [NativeJob]::Emit('{"event":"unknown","nonce":"' + [NativeJob]::Nonce + '"}')
} finally {
 if ($job -ne [IntPtr]::Zero) { [void][NativeJob]::CloseHandle($job) }
 if ($pi.hThread -ne [IntPtr]::Zero) { [void][NativeJob]::CloseHandle($pi.hThread) }
 if ($pi.hProcess -ne [IntPtr]::Zero) { [void][NativeJob]::CloseHandle($pi.hProcess) }
 if ($out -ne [IntPtr]::Zero) { [void][NativeJob]::CloseHandle($out) }
 if ($err -ne [IntPtr]::Zero) { [void][NativeJob]::CloseHandle($err) }
 if ($readOut -ne [IntPtr]::Zero) { [void][NativeJob]::CloseHandle($readOut) }
 if ($readErr -ne [IntPtr]::Zero) { [void][NativeJob]::CloseHandle($readErr) }
 if ($inputRead -ne [IntPtr]::Zero) { [void][NativeJob]::CloseHandle($inputRead) }
 if ($inputWrite -ne [IntPtr]::Zero) { [void][NativeJob]::CloseHandle($inputWrite) }
}
