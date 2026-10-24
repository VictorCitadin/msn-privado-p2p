// ============================================================================
// Vitinho e Will - Captura de Áudio do Sistema EXCLUINDO o próprio aplicativo
// ----------------------------------------------------------------------------
// Usa a API nativa do Windows 10 2004+ / Windows 11 "Process Loopback"
// (AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK) no modo
// PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE.
//
// Resultado: captura TODO o som do PC (jogo, filme, YouTube, Spotify...)
// MENOS o som que sai do processo do app (voz do amigo, DJ Bot, efeitos),
// eliminando 100% o retorno da voz no compartilhamento de tela.
//
// Uso:   loopback-capture.exe <pid-do-app> [exclude|include]
// Saída: PCM s16le 48000 Hz estéreo contínuo no stdout.
// Encerra sozinho quando o stdin é fechado (app principal fechou).
//
// Compilação (csc do .NET Framework, presente em todo Windows):
//   npm run build:loopback
// ============================================================================
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace VitinhoWillLoopback
{
    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint numBufferFrames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint numPaddingFrames);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr pFormat, out IntPtr closestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr deviceFormat);
        [PreserveSig] int GetDevicePeriod(out long defaultDevicePeriod, out long minimumDevicePeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService([MarshalAs(UnmanagedType.LPStruct)] Guid interfaceId, [MarshalAs(UnmanagedType.IUnknown)] out object interfacePointer);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint numFramesToRead, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint numFramesRead);
        [PreserveSig] int GetNextPacketSize(out uint numFramesInNextPacket);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig] int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceCompletionHandler
    {
        [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
    }

    // Marcador obrigatório: o callback de ativação precisa ser "agile" (free-threaded)
    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAgileObject { }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    class CompletionHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public int Hr = -1;
        public object Result;

        public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation)
        {
            try
            {
                int activateHr;
                object iface;
                int hr = activateOperation.GetActivateResult(out activateHr, out iface);
                Hr = hr < 0 ? hr : activateHr;
                Result = iface;
            }
            catch (Exception ex)
            {
                Hr = Marshal.GetHRForException(ex);
            }
            Done.Set();
            return 0;
        }
    }

    static class Program
    {
        const string VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK = "VAD\\Process_Loopback";
        static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");

        const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
        const uint AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
        const uint AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;
        const uint AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;
        const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;

        const int SAMPLE_RATE = 48000;
        const int CHANNELS = 2;
        const int BYTES_PER_FRAME = 4; // 16-bit * 2 canais

        [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = true)]
        static extern int ActivateAudioInterfaceAsync(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
            [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
            IntPtr activationParams,
            IActivateAudioInterfaceCompletionHandler completionHandler,
            out IActivateAudioInterfaceAsyncOperation activationOperation);

        static volatile bool running = true;

        static void Fail(string message, int hr)
        {
            Console.Error.WriteLine("LOOPBACK_ERROR " + message + " hr=0x" + hr.ToString("X8"));
            Console.Error.Flush();
            Environment.Exit(2);
        }

        [MTAThread]
        static int Main(string[] args)
        {
            if (args.Length < 1)
            {
                Console.Error.WriteLine("uso: loopback-capture.exe <pid> [exclude|include]");
                return 1;
            }

            uint targetPid = uint.Parse(args[0]);
            int loopbackMode = (args.Length > 1 && args[1] == "include") ? 0 : 1; // 1 = EXCLUDE_TARGET_PROCESS_TREE

            // Encerra automaticamente quando o app principal fechar (stdin fechado)
            Thread stdinWatcher = new Thread(delegate ()
            {
                try
                {
                    Stream stdin = Console.OpenStandardInput();
                    byte[] tmp = new byte[64];
                    while (stdin.Read(tmp, 0, tmp.Length) > 0) { }
                }
                catch { }
                running = false;
                Environment.Exit(0);
            });
            stdinWatcher.IsBackground = true;
            stdinWatcher.Start();

            // AUDIOCLIENT_ACTIVATION_PARAMS { ActivationType; { TargetProcessId; ProcessLoopbackMode } }
            IntPtr activationParams = Marshal.AllocHGlobal(12);
            Marshal.WriteInt32(activationParams, 0, 1); // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
            Marshal.WriteInt32(activationParams, 4, (int)targetPid);
            Marshal.WriteInt32(activationParams, 8, loopbackMode);

            // PROPVARIANT (VT_BLOB) apontando para os parâmetros de ativação
            int propSize = IntPtr.Size == 8 ? 24 : 16;
            IntPtr propVariant = Marshal.AllocHGlobal(propSize);
            for (int i = 0; i < propSize; i++) Marshal.WriteByte(propVariant, i, 0);
            Marshal.WriteInt16(propVariant, 0, 65); // VT_BLOB
            Marshal.WriteInt32(propVariant, 8, 12); // cbSize
            Marshal.WriteIntPtr(propVariant, IntPtr.Size == 8 ? 16 : 12, activationParams);

            CompletionHandler handler = new CompletionHandler();
            IActivateAudioInterfaceAsyncOperation asyncOp;
            int hrActivate = ActivateAudioInterfaceAsync(
                VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, IID_IAudioClient, propVariant, handler, out asyncOp);
            if (hrActivate < 0) Fail("ActivateAudioInterfaceAsync", hrActivate);

            if (!handler.Done.WaitOne(5000)) Fail("ActivateTimeout", -1);
            if (handler.Hr < 0 || handler.Result == null) Fail("ActivateResult", handler.Hr);

            IAudioClient client = (IAudioClient)handler.Result;

            // WAVEFORMATEX: PCM 16-bit 48 kHz estéreo
            IntPtr format = Marshal.AllocHGlobal(18);
            Marshal.WriteInt16(format, 0, 1);                                   // WAVE_FORMAT_PCM
            Marshal.WriteInt16(format, 2, (short)CHANNELS);
            Marshal.WriteInt32(format, 4, SAMPLE_RATE);
            Marshal.WriteInt32(format, 8, SAMPLE_RATE * BYTES_PER_FRAME);
            Marshal.WriteInt16(format, 12, (short)BYTES_PER_FRAME);
            Marshal.WriteInt16(format, 14, 16);
            Marshal.WriteInt16(format, 16, 0);

            uint flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                         AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
            int hr = client.Initialize(0 /* SHARED */, flags, 200000 /* 20ms */, 0, format, IntPtr.Zero);
            if (hr < 0) Fail("Initialize", hr);

            AutoResetEvent bufferReady = new AutoResetEvent(false);
            hr = client.SetEventHandle(bufferReady.SafeWaitHandle.DangerousGetHandle());
            if (hr < 0) Fail("SetEventHandle", hr);

            object captureObj;
            hr = client.GetService(IID_IAudioCaptureClient, out captureObj);
            if (hr < 0 || captureObj == null) Fail("GetService", hr);
            IAudioCaptureClient capture = (IAudioCaptureClient)captureObj;

            hr = client.Start();
            if (hr < 0) Fail("Start", hr);

            Console.Error.WriteLine("LOOPBACK_READY pid=" + targetPid + " mode=" + (loopbackMode == 1 ? "exclude" : "include"));
            Console.Error.Flush();

            Stream stdout = Console.OpenStandardOutput();
            byte[] buffer = new byte[SAMPLE_RATE * BYTES_PER_FRAME];

            try
            {
                while (running)
                {
                    bufferReady.WaitOne(100);
                    uint packetFrames;
                    while (running && capture.GetNextPacketSize(out packetFrames) >= 0 && packetFrames > 0)
                    {
                        IntPtr data;
                        uint framesRead, bufferFlags;
                        ulong devicePosition, qpcPosition;
                        hr = capture.GetBuffer(out data, out framesRead, out bufferFlags, out devicePosition, out qpcPosition);
                        if (hr < 0) break;

                        int bytes = (int)framesRead * BYTES_PER_FRAME;
                        if (bytes > buffer.Length) buffer = new byte[bytes];
                        if ((bufferFlags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || data == IntPtr.Zero)
                            Array.Clear(buffer, 0, bytes);
                        else
                            Marshal.Copy(data, buffer, 0, bytes);

                        capture.ReleaseBuffer(framesRead);

                        if (bytes > 0)
                        {
                            stdout.Write(buffer, 0, bytes);
                            stdout.Flush();
                        }
                    }
                }
            }
            catch (IOException)
            {
                // stdout fechado: app principal encerrou a captura
            }

            try { client.Stop(); } catch { }
            return 0;
        }
    }
}
