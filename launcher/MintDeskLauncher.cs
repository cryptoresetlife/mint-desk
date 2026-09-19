using System;
using System.IO;
using System.Net;
using System.Diagnostics;
using System.Threading;
using System.Windows.Forms;
using System.Drawing;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Net.NetworkInformation;
class MintDeskLauncher {
  static string Root=AppDomain.CurrentDomain.BaseDirectory;
  static string Url="http://127.0.0.1:8792/";
  static Process Child;
  static string InstanceFor(string root){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar).ToLowerInvariant()))).Replace("-","").ToLowerInvariant();}
  static int Classify(string body){return Regex.IsMatch(body,"\"app\"\\s*:\\s*\"mint-desk\"")&&Regex.IsMatch(body,"\"instanceId\"\\s*:\\s*\""+InstanceFor(Root)+"\"")?1:2;}
  // 0 = no listener, 1 = this folder, 2 = another service, 3 = unverified. Never open
  // another copy's in-memory wallets just because its app name matches.
  internal static int Probe(){
    try{
      int port=new Uri(Url).Port;bool listening=false;
      foreach(var endpoint in IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners()){
        if(endpoint.Port==port&&(IPAddress.IsLoopback(endpoint.Address)||endpoint.Address.Equals(IPAddress.Any)||endpoint.Address.Equals(IPAddress.IPv6Any))){listening=true;break;}
      }
      // A refused loopback connection can take longer than 800 ms on Windows.
      // Check the OS listener table instead of interpreting HTTP timeout as use.
      if(!listening)return 0;
      var r=(HttpWebRequest)WebRequest.Create(Url+"health");r.Proxy=null;r.Timeout=3000;r.ReadWriteTimeout=3000;r.AllowAutoRedirect=false;
      using(var response=r.GetResponse())using(var s=new StreamReader(response.GetResponseStream()))return Classify(s.ReadToEnd());
    }catch(WebException e){return e.Status==WebExceptionStatus.ConnectFailure?0:e.Status==WebExceptionStatus.ProtocolError?2:3;}catch{return 3;}
  }
  static void Open(){
    var window=Path.Combine(Root,"MintDeskWindow.exe");
    if(!File.Exists(window))throw new Exception("缺少 MintDeskWindow.exe，请完整解压新版安装包。");
    Process.Start(new ProcessStartInfo(window){WorkingDirectory=Root,UseShellExecute=true});
  }
  [STAThread] static void Main(){
    Application.EnableVisualStyles();
    int existing=Probe();
    if(existing==1){Open();return;}
    if(existing==2){MessageBox.Show("8792 端口已有另一份 Mint Desk、旧版后台或其他服务。为避免显示另一文件夹的 RPC 和钱包，本次没有打开它。\n\n请先在原软件左下角点击“停止任务并退出软件”，等后台退出后，再打开这份 Mint Desk.exe。退出后内存钱包需要重新导入；正在运行的任务请先自行处理。","Mint Desk · 后台冲突",MessageBoxButtons.OK,MessageBoxIcon.Information);return;}
    if(existing==3){MessageBox.Show("无法核实本机 8792 端口上的服务，可能是服务正在启动或响应超时。本次没有打开其他后台。请稍后重试。","Mint Desk · 后台检查未完成",MessageBoxButtons.OK,MessageBoxIcon.Information);return;}
    var exe=Path.Combine(Root,"runtime","node.exe");var entry=Path.Combine(Root,"server.mjs");
    if(!File.Exists(exe)||!File.Exists(entry)){MessageBox.Show("请先完整解压 ZIP，再打开 Mint Desk.exe。","Mint Desk");return;}
    try{
      Child=Process.Start(new ProcessStartInfo(exe,"\""+entry+"\""){WorkingDirectory=Root,UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden});
      for(int i=0;i<60&&Probe()!=1;i++){if(Child.HasExited)throw new Exception("软件服务启动失败，请确认已完整解压，并检查是否已有旧版后台占用 8792 端口。");Thread.Sleep(250);}
      if(Probe()!=1)throw new Exception("本机服务未就绪或后台不属于当前文件夹，请检查 8792 端口。");
      Open();
      var tray=new NotifyIcon{Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application,Text="Mint Desk · 双击打开",Visible=true};
      tray.DoubleClick+=(s,e)=>Open();var menu=new ContextMenu();menu.MenuItems.Add("打开 Mint Desk",(s,e)=>Open());menu.MenuItems.Add("退出方法：在软件左下角点击停止并退出",(s,e)=>Open());tray.ContextMenu=menu;
      var timer=new System.Windows.Forms.Timer{Interval=1000};timer.Tick+=(s,e)=>{if(Child.HasExited){tray.Visible=false;Application.Exit();}};timer.Start();Application.Run();tray.Dispose();
    }catch(Exception e){MessageBox.Show(e.Message,"Mint Desk",MessageBoxButtons.OK,MessageBoxIcon.Error);}
  }
}
