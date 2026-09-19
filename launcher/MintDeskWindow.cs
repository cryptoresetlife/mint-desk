using System;
using System.IO;
using System.Drawing;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// Own top-level window: taskbar identity and icon belong to Mint Desk, not Edge.
class MintDeskWindow : Form {
  const string Home="http://127.0.0.1:8792/";
  WebView2 view;
  bool checking;
  int unavailable;
  readonly Timer timer=new Timer { Interval=3000 };
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
  static extern int SetCurrentProcessExplicitAppUserModelID(string appID);

  internal static bool IsHome(string value){
    Uri uri;return Uri.TryCreate(value,UriKind.Absolute,out uri)&&uri.Scheme=="http"&&uri.Host=="127.0.0.1"&&uri.Port==8792&&String.IsNullOrEmpty(uri.UserInfo);
  }
  static void External(string value){
    Uri uri;if(!Uri.TryCreate(value,UriKind.Absolute,out uri)||uri.Scheme!="https"||!String.IsNullOrEmpty(uri.UserInfo))return;
    try{Process.Start(new ProcessStartInfo(uri.AbsoluteUri){UseShellExecute=true});}catch{MessageBox.Show("无法打开链接，请在浏览器中打开对应项目页面。","Mint Desk");}
  }
  MintDeskWindow(){
    Text="Mint Desk";Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath);
    Width=1380;Height=920;MinimumSize=new Size(900,650);
    StartPosition=FormStartPosition.CenterScreen;BackColor=Color.FromArgb(15,43,34);
    view=new WebView2 { Dock=DockStyle.Fill,DefaultBackgroundColor=BackColor };
    Controls.Add(view);Shown+=async(s,e)=>await Initialize();
    timer.Tick+=async(s,e)=>{
      if(checking)return;checking=true;
      try{
        int state=await Task.Run(()=>MintDeskLauncher.Probe());
        if(state==1)unavailable=0;
        else if(state==2||state==0||++unavailable>=3){timer.Stop();Close();}
      }finally{checking=false;}
    };
    FormClosed+=(s,e)=>{timer.Stop();timer.Dispose();view.Dispose();};
  }
  async Task Initialize(){
    try{
      var profile=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"data","webview2");
      var environment=await CoreWebView2Environment.CreateAsync(null,profile);
      if(IsDisposed)return;
      await view.EnsureCoreWebView2Async(environment);
      view.CoreWebView2.Settings.IsPasswordAutosaveEnabled=false;
      view.CoreWebView2.Settings.IsGeneralAutofillEnabled=false;
      view.CoreWebView2.Settings.AreDevToolsEnabled=false;
      view.CoreWebView2.NavigationStarting+=(s,e)=>{if(!IsHome(e.Uri)){e.Cancel=true;External(e.Uri);}};
      view.CoreWebView2.NewWindowRequested+=(s,e)=>{e.Handled=true;if(e.IsUserInitiated)External(e.Uri);};
      view.CoreWebView2.PermissionRequested+=(s,e)=>{e.State=CoreWebView2PermissionState.Deny;};
      view.CoreWebView2.DownloadStarting+=(s,e)=>{e.Cancel=true;};
      view.CoreWebView2.Navigate(Home);timer.Start();
    }catch(Exception){
      MessageBox.Show("独立窗口启动失败。请确认已完整解压，且电脑已安装 Microsoft Edge WebView2 Runtime。后台任务不会因此停止。","Mint Desk",MessageBoxButtons.OK,MessageBoxIcon.Information);
      Close();
    }
  }
  [STAThread] static void Main(){
    SetCurrentProcessExplicitAppUserModelID("MintDesk.Desktop.V1");
    Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
    if(MintDeskLauncher.Probe()!=1){MessageBox.Show("未找到当前文件夹的后台，请从 Mint Desk.exe 启动。","Mint Desk");return;}
    Application.Run(new MintDeskWindow());
  }
}
