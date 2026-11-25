import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { Camera, CameraOff, ScanFace, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { mysql } from "@/integrations/mysql/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  matchStaffFace,
  recordAdminPinOverride,
  recordFaceAttendance,
  saveFaceEnrollment,
} from "@/lib/attendance.functions";
import { hasAny } from "@/lib/staff-auth";

export const Route = createFileRoute("/_authenticated/clock")({
  head: () => ({
    meta: [
      { title: "Time Clock — CantiLounge Hub" },
      {
        name: "description",
        content: "Face-verified staff attendance and shift history at CantiLounge.",
      },
    ],
  }),
  component: ClockPage,
});

type FaceCandidate = { fullName: string; role: string; clockedIn: boolean };
type FaceApi = typeof import("@vladmandic/face-api");

const fmt = (d: string) =>
  new Date(d).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

function manilaTodayBounds() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const start = new Date(`${values["year"]}-${values["month"]}-${values["day"]}T00:00:00+08:00`);
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

function eyeAspectRatio(eye: { x: number; y: number }[]) {
  const length = (a: number, b: number) => {
    const left = eye[a];
    const right = eye[b];
    if (!left || !right) return 0;
    return Math.hypot(left.x - right.x, left.y - right.y);
  };
  const width = length(0, 3);
  return width > 0 ? (length(1, 5) + length(2, 4)) / (2 * width) : 0;
}

function ClockPage() {
  const { staff } = Route.useRouteContext();
  const isMgr = hasAny(staff.roles, ["ADMIN", "MANAGER"]);
  const isAdmin = hasAny(staff.roles, ["ADMIN"]);
  const qc = useQueryClient();
  const matchFace = useServerFn(matchStaffFace);
  const saveEnrollment = useServerFn(saveFaceEnrollment);
  const recordFace = useServerFn(recordFaceAttendance);
  const pinOverride = useServerFn(recordAdminPinOverride);
  const [now, setNow] = useState(() => new Date());
  const [breakMin, setBreakMin] = useState("0");
  const [page, setPage] = useState(0);
  const [cameraOn, setCameraOn] = useState(false);
  const [modelsReady, setModelsReady] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [faceDetected, setFaceDetected] = useState(false);
  const [candidate, setCandidate] = useState<FaceCandidate | null>(null);
  const [blinked, setBlinked] = useState(false);
  const [faceBusy, setFaceBusy] = useState(false);
  const [attendanceBusy, setAttendanceBusy] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideTarget, setOverrideTarget] = useState("");
  const [adminPin, setAdminPin] = useState("");
  const [overrideAction, setOverrideAction] = useState<"CLOCK_IN" | "CLOCK_OUT">("CLOCK_IN");
  const [overrideBusy, setOverrideBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const faceApiRef = useRef<FaceApi | null>(null);
  const descriptorRef = useRef<number[] | null>(null);
  const matchingRef = useRef(false);
  const eyeClosedRef = useRef(false);
  const openEyeRatioRef = useRef<number | null>(null);
  const pageSize = 50;
  const bounds = manilaTodayBounds();

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const {
    data: attendancePage,
    error: attendanceError,
    isPending: attendancePending,
  } = useQuery({
    queryKey: ["attendance", isMgr, staff.userId, page, bounds.start],
    queryFn: async () => {
      let request = mysql
        .from("attendance_logs")
        .select(
          "id, user_id, clock_in, clock_out, break_minutes, total_hours, overtime_min, is_late, verification_method, staff_profiles(full_name, hourly_rate)",
          { count: "exact" },
        )
        .gte("clock_in", bounds.start)
        .lt("clock_in", bounds.end)
        .order("clock_in", { ascending: false });
      if (!isMgr) request = request.eq("user_id", staff.userId);
      const { data, count, error } = await request.range(
        page * pageSize,
        (page + 1) * pageSize - 1,
      );
      if (error) throw error;
      return { logs: data, count: count ?? 0 };
    },
  });
  const { data: staffOptions } = useQuery({
    queryKey: ["clock-override-staff"],
    enabled: isAdmin,
    queryFn: async () => {
      const { data, error } = await mysql
        .from("staff_profiles")
        .select("id, full_name")
        .eq("is_active", true)
        .order("full_name");
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (!cameraOn) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setModelsReady(false);
      setFaceDetected(false);
      setCandidate(null);
      descriptorRef.current = null;
      setBlinked(false);
      eyeClosedRef.current = false;
      openEyeRatioRef.current = null;
      return;
    }

    let cancelled = false;
    const startCamera = async () => {
      try {
        setCameraError("");
        const faceapi = await import("@vladmandic/face-api");
        faceApiRef.current = faceapi;
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri("/models"),
          faceapi.nets.faceLandmark68TinyNet.loadFromUri("/models"),
          faceapi.nets.faceRecognitionNet.loadFromUri("/models"),
        ]);
        if (!cancelled) setModelsReady(true);
      } catch (error) {
        if (!cancelled) {
          setCameraError(error instanceof Error ? error.message : "Could not start camera.");
          setCameraOn(false);
        }
      }
    };
    void startCamera();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [cameraOn]);

  useEffect(() => {
    if (!cameraOn || !modelsReady || !videoRef.current || !faceApiRef.current) return;
    let cancelled = false;
    let blinkScanBusy = false;
    const scanBlink = async () => {
      if (blinkScanBusy) return;
      const video = videoRef.current;
      const faceapi = faceApiRef.current;
      if (!video || !faceapi || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      blinkScanBusy = true;
      try {
        const result = await faceapi
          .detectSingleFace(
            video,
            new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.45 }),
          )
          .withFaceLandmarks(true);
        if (cancelled) return;
        if (!result) {
          eyeClosedRef.current = false;
          setFaceDetected(false);
          return;
        }
        setFaceDetected(true);
        const eyes: [number, number] = [
          eyeAspectRatio(result.landmarks.getLeftEye()),
          eyeAspectRatio(result.landmarks.getRightEye()),
        ];
        const averageEyeRatio = (eyes[0] + eyes[1]) / 2;
        if (eyeClosedRef.current) {
          const openEyeRatio = openEyeRatioRef.current;
          if (openEyeRatio !== null && eyes.some((ratio) => ratio > openEyeRatio * 0.78)) {
            setBlinked(true);
            eyeClosedRef.current = false;
          }
        } else if (averageEyeRatio > 0 && averageEyeRatio < 0.5) {
          const calibratedOpenEyeRatio = Math.max(openEyeRatioRef.current ?? 0, averageEyeRatio);
          openEyeRatioRef.current = calibratedOpenEyeRatio;
          if (eyes.every((ratio) => ratio < calibratedOpenEyeRatio * 0.68)) {
            eyeClosedRef.current = true;
          }
        }
      } catch (error) {
        if (!cancelled) {
          setCameraError(error instanceof Error ? error.message : "Face blink detection failed.");
        }
      } finally {
        blinkScanBusy = false;
      }
    };
    const blinkTimer = setInterval(() => void scanBlink(), 100);
    void scanBlink();
    return () => {
      cancelled = true;
      clearInterval(blinkTimer);
    };
  }, [cameraOn, modelsReady]);

  useEffect(() => {
    if (!cameraOn || !modelsReady || !videoRef.current || !faceApiRef.current) return;
    let cancelled = false;
    const scan = async () => {
      if (matchingRef.current) return;
      const video = videoRef.current;
      const faceapi = faceApiRef.current;
      if (!video || !faceapi || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      matchingRef.current = true;
      setFaceBusy(true);
      try {
        const result = await faceapi
          .detectSingleFace(
            video,
            new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.45 }),
          )
          .withFaceLandmarks(true)
          .withFaceDescriptor();
        if (cancelled) return;
        if (!result) {
          descriptorRef.current = null;
          eyeClosedRef.current = false;
          setFaceDetected(false);
          setCandidate(null);
          setBlinked(false);
          return;
        }
        setFaceDetected(true);
        descriptorRef.current = Array.from(result.descriptor);
        const match = await matchFace({ data: { descriptor: descriptorRef.current } });
        if (!cancelled) setCandidate(match);
      } catch (error) {
        if (!cancelled) {
          setCameraError(error instanceof Error ? error.message : "Face matching failed.");
        }
      } finally {
        matchingRef.current = false;
        if (!cancelled) setFaceBusy(false);
      }
    };
    const timer = setInterval(() => void scan(), 1400);
    void scan();
    return () => {
      cancelled = true;
      clearInterval(timer);
      matchingRef.current = false;
    };
  }, [cameraOn, matchFace, modelsReady]);

  const actWithFace = async () => {
    if (!candidate || !descriptorRef.current || !blinked || attendanceBusy) return;
    const action = candidate.clockedIn ? "CLOCK_OUT" : "CLOCK_IN";
    setAttendanceBusy(true);
    try {
      const result = await recordFace({
        data: {
          descriptor: descriptorRef.current,
          action,
          breakMinutes: action === "CLOCK_OUT" ? Number(breakMin) || 0 : 0,
        },
      });
      toast.success(`${result.fullName} clocked ${action === "CLOCK_IN" ? "in" : "out"}.`);
      setCandidate(null);
      setBlinked(false);
      setPage(0);
      void qc.invalidateQueries({ queryKey: ["attendance"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not record attendance.");
    } finally {
      setAttendanceBusy(false);
    }
  };

  const enrollCurrentFace = async () => {
    if (!descriptorRef.current || !blinked) return;
    try {
      await saveEnrollment({ data: { descriptor: descriptorRef.current } });
      toast.success("Face ID enrollment saved for your staff profile.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save face enrollment.");
    }
  };

  const submitOverride = async () => {
    if (!overrideTarget || !adminPin) return;
    setOverrideBusy(true);
    try {
      const result = await pinOverride({
        data: {
          targetUserId: overrideTarget,
          adminPin,
          action: overrideAction,
          breakMinutes: overrideAction === "CLOCK_OUT" ? Number(breakMin) || 0 : 0,
        },
      });
      toast.success(`${result.fullName} clocked ${overrideAction === "CLOCK_IN" ? "in" : "out"}.`);
      setAdminPin("");
      setOverrideOpen(false);
      setPage(0);
      void qc.invalidateQueries({ queryKey: ["attendance"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not authorize PIN override.");
    } finally {
      setOverrideBusy(false);
    }
  };

  const logs = attendancePage?.logs;
  const totalLogs = attendancePage?.count ?? 0;
  const totalPages = Math.ceil(totalLogs / pageSize);

  return (
    <div className="mx-auto max-w-6xl p-4 text-[#FAF0E6] sm:p-6">
      <header className="mb-6">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-[#B85D19]">
          <ScanFace className="size-4" />
          Attendance kiosk
        </p>
        <h1 className="mt-2 text-4xl">Time Clock</h1>
      </header>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(18rem,0.9fr)]">
        <section className="rounded-3xl border border-[#3A251C] bg-[#1C120E] p-4 sm:p-6">
          <div className="relative aspect-video overflow-hidden rounded-2xl border border-[#4A3831] bg-[#120B09]">
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className={`size-full object-cover ${cameraOn ? "" : "hidden"}`}
            />
            {!cameraOn && (
              <div className="absolute inset-0 grid place-items-center text-[#A98D7D]">
                <div className="text-center">
                  <CameraOff className="mx-auto size-10" />
                  <p className="mt-3 text-sm">Camera is off</p>
                </div>
              </div>
            )}
            {cameraOn && (
              <div className="absolute left-3 top-3 rounded-full border border-white/15 bg-black/65 px-3 py-1 text-xs text-white">
                {candidate
                  ? blinked
                    ? "Face verified · blink detected"
                    : "Face found · blink to confirm"
                  : faceDetected
                    ? blinked
                      ? "Face detected · ready to enroll"
                      : "Face detected · blink to enroll"
                    : faceBusy
                      ? "Scanning"
                      : modelsReady
                        ? "Center your face in the frame"
                        : "Loading face models…"}
              </div>
            )}
          </div>
          {cameraError && (
            <p
              role="alert"
              className="mt-3 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
            >
              {cameraError}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => setCameraOn((value) => !value)}
              className="bg-[#B85D19] text-white hover:bg-[#A34F15]"
            >
              {cameraOn ? (
                <CameraOff className="mr-2 size-4" />
              ) : (
                <Camera className="mr-2 size-4" />
              )}
              {cameraOn ? "Stop camera" : "Start camera"}
            </Button>
            {cameraOn && (
              <Button
                type="button"
                variant="outline"
                disabled={!modelsReady || !descriptorRef.current || !blinked}
                onClick={() => void enrollCurrentFace()}
                className="border-[#4A3831] text-[#E9B988]"
              >
                Enroll my face
              </Button>
            )}
          </div>
          <div className="mt-4 min-h-32 rounded-2xl border border-[#3A251C] bg-[#120B09] p-4">
            {candidate ? (
              <>
                <div className="flex items-center gap-2 text-success">
                  <ShieldCheck className="size-5" />
                  <span className="text-xs font-semibold uppercase tracking-wider">
                    Identity matched
                  </span>
                </div>
                <p className="mt-2 font-display text-2xl">{candidate.fullName}</p>
                <p className="text-sm text-[#A98D7D]">{candidate.role || "Staff"}</p>
                {candidate.clockedIn && (
                  <Input
                    type="number"
                    min={0}
                    max={240}
                    value={breakMin}
                    onChange={(event) => setBreakMin(event.target.value)}
                    placeholder="Break minutes"
                    className="mt-3 max-w-52 border-[#3A251C] bg-[#1C120E]"
                  />
                )}
                <Button
                  type="button"
                  disabled={!blinked || attendanceBusy}
                  onClick={() => void actWithFace()}
                  className="mt-3 w-full bg-[#B85D19] text-white hover:bg-[#A34F15]"
                >
                  {attendanceBusy
                    ? candidate.clockedIn
                      ? "Clocking Out…"
                      : "Clocking In…"
                    : candidate.clockedIn
                      ? "Clock Out"
                      : "Clock In"}
                </Button>
              </>
            ) : (
              <div className="grid min-h-24 place-items-center text-center text-sm text-[#A98D7D]">
                {cameraOn
                  ? "Look at the camera and blink once to verify your face."
                  : "Start the camera to clock in or out."}
              </div>
            )}
          </div>
          {isAdmin && (
            <div className="mt-4 border-t border-[#3A251C] pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOverrideOpen((value) => !value)}
                className="border-[#4A3831] text-[#E9B988]"
              >
                Admin PIN override
              </Button>
              {overrideOpen && (
                <div className="mt-3 grid gap-2 rounded-xl border border-[#3A251C] p-3 sm:grid-cols-2">
                  <select
                    aria-label="Staff member for PIN override"
                    value={overrideTarget}
                    onChange={(event) => setOverrideTarget(event.target.value)}
                    className="h-10 rounded-lg border border-[#3A251C] bg-[#120B09] px-3 text-sm"
                  >
                    <option value="">Select staff member</option>
                    {(staffOptions ?? []).map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.full_name}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="PIN override action"
                    value={overrideAction}
                    onChange={(event) =>
                      setOverrideAction(event.target.value as "CLOCK_IN" | "CLOCK_OUT")
                    }
                    className="h-10 rounded-lg border border-[#3A251C] bg-[#120B09] px-3 text-sm"
                  >
                    <option value="CLOCK_IN">Clock In</option>
                    <option value="CLOCK_OUT">Clock Out</option>
                  </select>
                  <Input
                    type="password"
                    inputMode="numeric"
                    autoComplete="current-password"
                    maxLength={6}
                    value={adminPin}
                    onChange={(event) =>
                      setAdminPin(event.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    placeholder="Confirm your admin PIN"
                    className="border-[#3A251C] bg-[#120B09]"
                  />
                  <Button
                    type="button"
                    disabled={overrideBusy || !overrideTarget || adminPin.length < 4}
                    onClick={() => void submitOverride()}
                    className="bg-[#B85D19] text-white hover:bg-[#A34F15]"
                  >
                    {overrideBusy ? "Verifying…" : "Authorize"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="rounded-3xl border border-[#3A251C] bg-[#1C120E] p-4 sm:p-6">
          <div className="font-mono text-5xl font-bold tabular text-[#E9B988]">
            {now.toLocaleTimeString("en-PH", {
              timeZone: "Asia/Manila",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </div>
          <p className="mt-2 text-sm text-[#C8B6A6]">
            {now.toLocaleDateString("en-PH", {
              timeZone: "Asia/Manila",
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </p>
          <h2 className="mb-3 mt-8 text-xl">
            {isMgr ? "Today's team shift log" : "Today's shift log"}
          </h2>
          <div className="overflow-x-auto rounded-xl border border-[#3A251C]">
            {attendanceError ? (
              <p role="alert" className="p-4 text-sm text-destructive">
                Could not load attendance: {attendanceError.message}
              </p>
            ) : attendancePending ? (
              <p className="p-4 text-sm text-[#C8B6A6]">Loading attendance…</p>
            ) : logs?.length ? (
              <table className="w-full min-w-[560px] text-sm">
                <thead className="bg-[#251A15] text-left text-xs uppercase text-[#A98D7D]">
                  <tr>
                    {isMgr && <th className="p-3">Staff</th>}
                    <th className="p-3">Clock In</th>
                    <th className="p-3">Clock Out</th>
                    <th className="p-3">Hours</th>
                    <th className="p-3">Verification</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular">
                  {logs.map((log) => (
                    <tr key={log.id} className="border-t border-[#3A251C]">
                      {isMgr && <td className="p-3 font-sans">{log.staff_profiles?.full_name}</td>}
                      <td className="whitespace-nowrap p-3">{fmt(log.clock_in)}</td>
                      <td className="whitespace-nowrap p-3">
                        {log.clock_out ? (
                          fmt(log.clock_out)
                        ) : (
                          <span className="text-success">On shift</span>
                        )}
                      </td>
                      <td className="p-3">{log.total_hours ?? "—"}</td>
                      <td className="p-3">
                        <span className="rounded-full border border-[#B85D19]/40 bg-[#B85D19]/10 px-2 py-1 text-[10px] font-semibold text-[#E9B988]">
                          {log.verification_method === "FACE_ID"
                            ? "Face ID"
                            : log.verification_method === "PIN_OVERRIDE"
                              ? "PIN Override"
                              : "Manual"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="p-4 text-sm text-[#A98D7D]">No shifts recorded today.</p>
            )}
          </div>
          {totalPages > 1 && (
            <div className="mt-3 flex items-center justify-between text-sm text-[#A98D7D]">
              <span>
                Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, totalLogs)} of{" "}
                {totalLogs}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((current) => Math.max(0, current - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page + 1 >= totalPages}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
          <p className="mt-4 text-xs leading-relaxed text-[#8B7367]">
            Face descriptors are encrypted in transit and checked server-side. The blink prompt
            helps deter static-photo punches; it is not a full liveness guarantee.
          </p>
        </section>
      </div>
    </div>
  );
}
