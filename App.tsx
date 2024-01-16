import { useState, useRef, useEffect, useMemo } from 'react';
import { StyleSheet, Text, View, SafeAreaView, StatusBar, Button, ScrollView, Image, Pressable, TextInput, Alert, TouchableOpacity } from 'react-native';
import Share from 'react-native-share';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { Video, ResizeMode, AVPlaybackStatus } from 'expo-av';
import { FFmpegKit } from 'ffmpeg-kit-react-native';
import Slider from '@react-native-community/slider';
import Bar from './components/svgs/Bar';
import ArrowCircle from './components/svgs/ArrowCircle';
import ArrowLeft from './components/svgs/ArrowLeft';
import ShareSvg from './components/svgs/ShareSvg';
import { useFonts } from 'expo-font';

const outputDir = FileSystem.documentDirectory + "split-videos/"
export default function App() {
  const [fontsLoaded] = useFonts({
    'Roboto-Bold': require('./assets/fonts/ComicNeue-Bold.ttf'),
  });

  type uploadedVideo = {
    uri: string,
    filename: string,
  }
  type videoControlsType = {
    startTime: number,
    endTime: number,
    currentTime: number,
    maxTime: number,
    scale: "256" | "640" | "1280" | "1920" | null,
    rotate: 90 | -90 | 180 | null,
    amtToSegment: number,
  }
  const [uploadedVideoInfo, uploadedVideoInfoSet] = useState<uploadedVideo | null>(null);
  const [storedVideoUris, storedVideoUrisSet] = useState<string[]>([]);
  const [currentBarSelected, currentBarSelectedSet] = useState<"start" | "end">("start");
  const [showingSettings, showingSettingsSet] = useState(false);

  const previewVideo = useRef<Video>(null!)
  const [videoControls, videoControlsSet] = useState<videoControlsType>({
    startTime: 0,
    endTime: 0,
    currentTime: 0,
    maxTime: 0,
    scale: null,
    rotate: null,
    amtToSegment: 30,
  })

  const millToTime = (milliseconds: number) => {
    let seconds = Math.floor(milliseconds / 1000);
    let minutes = Math.floor(seconds / 60);
    let hours = Math.floor(minutes / 60);

    seconds = seconds % 60;
    minutes = minutes % 60;

    const returningArr = [
      hours.toString().padStart(2, '0'),
      minutes.toString().padStart(2, '0'),
      seconds.toString().padStart(2, '0'),
    ]

    return returningArr.join(':');
  }

  const videoDuration = useMemo(() => {
    if (!videoControls) return millToTime(0)

    if (videoControls.startTime > videoControls.endTime) return millToTime(0)

    const seenDur = videoControls.endTime - videoControls.startTime
    return millToTime(seenDur > 0 ? seenDur : 0)
  }, [videoControls])

  const onStartTimeChange = (startTime: number) => {
    videoControlsSet(prev => {
      const newControls = { ...prev }
      newControls.startTime = startTime

      if (newControls.startTime > newControls.endTime) {
        return prev
      }

      return newControls
    })

    previewVideo.current.playFromPositionAsync(startTime)
  };

  const onEndTimeChange = (endTime: number) => {
    let localOffset = 0

    videoControlsSet(prev => {
      const newControls = { ...prev }
      newControls.endTime = endTime

      if (newControls.endTime < newControls.startTime) {
        newControls.endTime = newControls.startTime
      }

      localOffset = (videoControls.endTime - videoControls.startTime) >= 1000 ? 1000 : 0
      return newControls
    });

    previewVideo.current.playFromPositionAsync(endTime - localOffset)
  }

  const uploadVideo = async () => {
    let result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos
    });
    if (!result.assets) return

    uploadedVideoInfoSet({
      uri: result.assets[0].uri,
      filename: result.assets[0].fileName ?? "videoToSplit"
    })

    videoControlsSet(prevControls => {
      return {
        ...prevControls,
        startTime: 0,
        currentTime: 0,
        endTime: result.assets[0].duration,
        maxTime: result.assets[0].duration
      }
    })
  };

  const ensureDirExists = async (directUri: string) => {
    const dirInfo = await FileSystem.getInfoAsync(directUri);

    if (!dirInfo.exists) {
      console.log("directory doesn't exist, creating…");
      await FileSystem.makeDirectoryAsync(directUri, { intermediates: true }).then(() => {
        console.log(`$successfully created directory`);
      }).catch(error => {
        console.log(`$error creating`, error);
      });
    }

    return dirInfo
  }

  const checkAtDirectory = async (passedUri: string): Promise<string[] | null> => {
    try {
      const seenUris = await FileSystem.readDirectoryAsync(passedUri)
      if (seenUris.length === 0) return null
      return seenUris

    } catch (error) {
      console.log(`$error trying to read this direct`, error);
      return null
    }
  }

  const deleteInDirectory = async (passedUri: string) => {
    await FileSystem.deleteAsync(passedUri).catch(e => {
      console.log(`couldn't delete directory`);
    })
  }

  const splitVideo = async (uploadedVideo: uploadedVideo, outputDir: string, seenVideoControls: videoControlsType, seenDuration: string) => {
    await ensureDirExists(outputDir)

    const rotateFilter = seenVideoControls.rotate === null ? "" :
      seenVideoControls.rotate === 90 ? `transpose=1,` :
        seenVideoControls.rotate === -90 ? `transpose=2,` :
          `rotate=PI:bilinear=0,`
    const scaleFilter = seenVideoControls.scale === null ? "" : `scale=${seenVideoControls.scale}:-1`

    const allFilters = `${rotateFilter}${scaleFilter}`
    const usingAFilter = seenVideoControls.rotate !== null || seenVideoControls.scale !== null

    const finalCommand = usingAFilter ?
      `-i ${uploadedVideo.uri} -vf "${allFilters}" -ss ${millToTime(seenVideoControls.startTime)} -t ${seenDuration} -map 0 -segment_time ${seenVideoControls.amtToSegment} -f segment -reset_timestamps 1 ${outputDir}${uploadedVideo.filename}%03d.mp4` :
      `-i ${uploadedVideo.uri} -c copy -ss ${millToTime(seenVideoControls.startTime)} -t ${seenDuration} -map 0 -segment_time ${seenVideoControls.amtToSegment} -f segment -reset_timestamps 1 ${outputDir}${uploadedVideo.filename}%03d.mp4`

    await FFmpegKit.execute(finalCommand).then(async session => {

      const returnCode = await session.getReturnCode();
      const duration = await session.getDuration();
      const failStackTrace = await session.getFailStackTrace();

      if (returnCode.isValueSuccess()) {
        console.log(`Encode completed successfully in ${duration} milliseconds;`);

      } else if (returnCode.isValueCancel()) {
        console.log('Encode canceled');
      } else {
        console.log(
          `failed and rc ${returnCode}.${failStackTrace}`,
        );
      }
    });
  };

  const onShare = async (seenUris: string[], seenOutputDir: string, singleShare = false) => {

    if (singleShare) {
      const shareResponse = await Share.open({
        url: seenOutputDir + seenUris[0],
        message: "Share your video",
      })

      if (shareResponse.success) {
        console.log(`$successfully shared`);
      }

    } else {
      const shareResponse = await Share.open({
        urls: seenUris.map(e => seenOutputDir + e),
        message: "Share your videos"
      })

      if (shareResponse.success) {
        console.log(`$successfully shared`);
      }
    }
  };

  const handleWantsToSplit = async () => {
    const prevUris = await checkAtDirectory(outputDir)
    if (prevUris) await deleteInDirectory(outputDir); storedVideoUrisSet([])

    await splitVideo(uploadedVideoInfo, outputDir, videoControls, videoDuration)

    const seenVideoUris = await checkAtDirectory(outputDir)
    if (seenVideoUris) storedVideoUrisSet(seenVideoUris)
  }

  const onPlaybackStatusUpdate = (status: any, seenVideoControls: videoControlsType) => {
    if (status.positionMillis >= seenVideoControls.endTime) {
      previewVideo.current.playFromPositionAsync(seenVideoControls.startTime)
    }
  }

  const changeRotation = (option: 90 | -90 | 180 | null) => {
    const translatedOption = option === null ? 90 :
      option === 90 ? 180 :
        option === 180 ? -90 :
          null

    videoControlsSet(prev => {
      return { ...prev, rotate: translatedOption }
    })
  }

  const changeResolution = (option: "256" | "640" | "1280" | "1920" | null, direction: "left" | "right") => {
    const optionsArr = ["256", "640", "1280", "1920", null]
    const foundIndex = optionsArr.findIndex(each => each === option)
    let usingOption = null
    let newIndex = 0

    if (direction === "left") {
      newIndex = foundIndex - 1
      if (newIndex < 0) newIndex = optionsArr.length - 1
    } else {
      newIndex = foundIndex + 1
      if (newIndex > optionsArr.length - 1) newIndex = 0
    }

    usingOption = optionsArr[newIndex]

    videoControlsSet(prev => {
      return { ...prev, scale: usingOption }
    })
  }
  const changeTimeSmall = async (option: "back" | "forward", seenCurrentBarSelected: "start" | "end", videoRef: Video) => {
    previewVideo.current.pauseAsync()

    videoControlsSet(prevVideoControls => {
      const transformDirection = option === "back" ? -100 : 100

      if (seenCurrentBarSelected === "start") {
        let newTime = prevVideoControls.startTime + transformDirection
        if (newTime < 0 || newTime > prevVideoControls.endTime) newTime = prevVideoControls.startTime

        videoRef.setPositionAsync(newTime)
        return { ...prevVideoControls, startTime: newTime }
      } else {
        let newTime = prevVideoControls.endTime + transformDirection
        if (newTime > prevVideoControls.maxTime || newTime < prevVideoControls.startTime) newTime = prevVideoControls.endTime

        videoRef.setPositionAsync(newTime)
        return { ...prevVideoControls, endTime: newTime }
      }
    })
  }


  if (!fontsLoaded) {
    return null;
  }

  return (
    <SafeAreaView style={styles.appContainer}>
      <StatusBar barStyle="light-content" backgroundColor={"#242734"} />

      <View style={{ flex: .5, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 8 }}>
        <Image
          style={{ width: 50, aspectRatio: "1/1", borderRadius: 8 }}
          source={require("./assets/logo.png")}
        />

        <Text style={{ fontWeight: "bold", fontSize: 32, color: "#fff", fontFamily: "Roboto-Bold" }}>Story Slice</Text>

        <Pressable onPress={() => { showingSettingsSet(true) }}>
          <Bar style={styles.svg} fill={"#fff"} />
        </Pressable>
      </View>

      {showingSettings && (
        <View style={{ position: "absolute", top: 0, right: 0, backgroundColor: "yellow", zIndex: 999, padding: 8, width: 300, minHeight: 700 }}>
          <Button title='Close' onPress={() => showingSettingsSet(false)} />

          <Text>Settings</Text>
        </View>
      )}

      <View style={{ backgroundColor: "#A6B1E1", flex: 2, flexDirection: "row", gap: 8, padding: 8 }}>
        <View style={{ flex: .6, gap: 8 }}>
          <Pressable style={[styles.settingsContSmall, { justifyContent: 'center', alignItems: 'center' }]} onPress={() => changeRotation(videoControls.rotate)}>
            <ArrowCircle height={40} width={40} rotation={videoControls.rotate === null ? 0 : videoControls.rotate === 90 ? 90 : videoControls.rotate === 180 ? 180 : 270} />
          </Pressable>

          <View style={[styles.settingsContSmall, { justifyContent: "center", alignItems: "center", position: 'relative' }]}>
            <Pressable onPress={() => { changeResolution(videoControls.scale, "left") }}>
              <ArrowLeft height={40} width={40} />
            </Pressable>

            <Text style={{}}>{videoControls.scale === null ? "Native" : `${videoControls.scale === "1920" ? "1080" : videoControls.scale === "1280" ? "720" : videoControls.scale === "640" ? "360" : "144"}p`}</Text>

            <Pressable style={{}} onPress={() => { changeResolution(videoControls.scale, "right") }}>
              <ArrowLeft height={40} width={40} rotation={180} />
            </Pressable>
          </View>
        </View>

        <View style={{ flex: 1.5, position: "relative", }}>
          <View style={{ alignItems: "center" }}>
            <Text style={{ opacity: videoControls.rotate === null ? 0 : 1, textAlign: "center", fontSize: 8 }}>rotate video {videoControls.rotate === 90 ? 90 : videoControls.rotate === 180 ? 180 : 270} degrees</Text>
            <Text>Duration: {videoDuration}s</Text>

            <Text>Move {currentBarSelected} 100ms</Text>

            <View style={{ flexDirection: "row", gap: 8 }}>
              <Pressable style={{ backgroundColor: 'green', padding: 8, borderRadius: 8, }} onPress={() => changeTimeSmall("back", currentBarSelected, previewVideo.current)}>
                <Text style={{ fontWeight: "bold" }}>backward</Text>
              </Pressable>

              <Pressable style={{ backgroundColor: 'green', padding: 8, borderRadius: 8, }} onPress={() => changeTimeSmall("forward", currentBarSelected, previewVideo.current)}>
                <Text style={{ fontWeight: "bold" }}>forward</Text>
              </Pressable>
            </View>
          </View>

          <Video
            style={{ flex: 1 }}
            ref={previewVideo}
            source={{ uri: uploadedVideoInfo ? uploadedVideoInfo.uri : "" }}
            useNativeControls
            resizeMode={ResizeMode.CONTAIN}
            isLooping
            onPlaybackStatusUpdate={(e) => { onPlaybackStatusUpdate(e, videoControls) }}
          />
        </View>

        <View style={{ flex: 1, position: "relative", justifyContent: "space-between", alignItems: "center" }}>
          <Text>{millToTime(videoControls.startTime)}</Text>

          <View style={{ transform: [{ rotate: "90deg" }], position: "absolute", top: 115, left: -65, width: 250, gap: 32 }}>
            <Slider
              onSlidingComplete={() => currentBarSelectedSet("end")}
              minimumValue={1}
              maximumValue={videoControls.maxTime}
              value={videoControls.endTime}
              onValueChange={onEndTimeChange}
              minimumTrackTintColor="#FFFFFF"
              maximumTrackTintColor="#000000"
            />

            <Slider
              // style={{ position: "absolute", top: 0, width: 100, transform: [{ rotate: "90deg" }] }}
              onSlidingComplete={() => currentBarSelectedSet("start")}
              vertical={true}
              minimumValue={0}
              maximumValue={videoControls.maxTime}
              value={videoControls.startTime}
              onValueChange={onStartTimeChange}
              minimumTrackTintColor="#FFFFFF"
              maximumTrackTintColor="#000000"
            />
          </View>

          <Text>{millToTime(videoControls.endTime)}</Text>
        </View>
      </View>

      <View style={{ flex: 1.5 }}>
        <ScrollView horizontal style={{ flex: 1 }}>
          {storedVideoUris.map(eachVideoUri => {
            return (
              <View key={eachVideoUri} style={{ backgroundColor: "#a6b1e1", flex: 1, width: 300, margin: 16, marginLeft: 0 }}>
                <Pressable style={{ margin: 8, marginLeft: "auto" }} onPress={() => { onShare([eachVideoUri], outputDir, true) }}>
                  <ShareSvg width={20} height={20} />
                </Pressable>

                <Video
                  style={{ height: 150, flex: 1 }}
                  source={{ uri: outputDir + eachVideoUri }}
                  useNativeControls
                  resizeMode={ResizeMode.CONTAIN}
                />
              </View>
            )
          })}
        </ScrollView>
      </View>

      <View style={{ backgroundColor: "#160D1A", flex: 1, flexDirection: 'row', justifyContent: "space-evenly", alignItems: "center" }}>
        <TouchableOpacity activeOpacity={0.8} style={styles.settingsButton} onPress={handleWantsToSplit}>
          <Text style={styles.settingsButtonText}>split</Text>
        </TouchableOpacity>

        <TouchableOpacity activeOpacity={0.8} style={styles.settingsButton} onPress={() => { onShare(storedVideoUris, outputDir) }}>
          <Text style={[styles.settingsButtonText, { fontSize: 30 }]}>share</Text>
        </TouchableOpacity>

        <TouchableOpacity activeOpacity={0.8} style={styles.settingsButton} onPress={uploadVideo}>
          <Text style={styles.settingsButtonText}>upload</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView >
  );
}

const styles = StyleSheet.create({
  appContainer: {
    flex: 1,
    backgroundColor: '#242734',
    display: "flex",
    flexDirection: "column"
  },
  settingsContSmall: {
    backgroundColor: "#dcd6f7",
    borderRadius: 8,
    paddingVertical: 16
  },
  settingsButton: {
    padding: 16,
    aspectRatio: "1/1",
    alignItems: "center",
    justifyContent: 'center',
    borderRadius: 500,
    backgroundColor: "#D6E5E3",
  },
  settingsButtonText: {
    fontWeight: "bold"
  },
  svg: {
    width: 25,
    height: 25
  }
});
